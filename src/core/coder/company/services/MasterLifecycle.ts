/**
 * MasterLifecycle — everything specific to the master agent:
 *   - `start` (fresh session) / `resumeExisting` (cold-start)
 *   - `resurrect`: re-run when a subordinate notifies after master exited
 *   - `notifyAboutSubordinate`: push a message to alive master OR resurrect it
 *   - `swapProvider` / `updateRoleConfigs` / `sendUserMessage`
 *
 * Exposes IMasterNotifier so peer services (SubordinateLifecycle,
 * HumanInTheLoop) can notify/query master state without depending on
 * the concrete class.
 *
 * Board context enrichment: when notifying master, appends board entries
 * since the watermark so the master doesn't need to call read_board.
 */

import { runCoder, type RunCoderOptions, type RunCoderHandle } from '../../index.js';
import { createCoderProvider } from '../../../providers/factory.js';
import { SessionStore } from '../../sessions/store.js';
import { loadConfig } from '../../../../utils/config.js';
import { buildMasterCompanyBlock } from '../system-prompts.js';
import type { CompanyContext } from '../types.js';
import type { SessionContext } from './SessionContext.js';
import type { HumanInTheLoop } from './HumanInTheLoop.js';
import type {
  IAgentStatusUpdater,
  IBoardPoster,
  IIdleController,
  IMasterNotifier,
  IMetaBusWirer,
} from './ports.js';

export type RoleConfig = {
  role: string;
  provider: string;
  model: string;
  tier: string;
  projectHints?: string[];
  skills?: string[];
};

export interface MasterLifecycleDeps {
  ctx: SessionContext;
  board: IBoardPoster;
  status: IAgentStatusUpdater;
  humanInLoop: HumanInTheLoop;
  wirer: IMetaBusWirer;
  idle: IIdleController;
  /** Facade handed to runCoder so tools can reach the orchestrator. */
  orchestratorRef: unknown;
}

export class MasterLifecycle implements IMasterNotifier {
  private _handle: RunCoderHandle | null = null;
  private _agentRunId: number | null = null;
  private _ended = false;
  private _endedWithError: string | null = null;
  private _companyContext: CompanyContext | null = null;
  private _promptBlock = '';

  private _roleConfigs: RoleConfig[] = [];

  /** Flag consumed by IdleController to trigger auto-continue. */
  private _shouldContinue = false;

  // Resurrection concurrency
  private resumingPromise: Promise<void> | null = null;
  private resumeQueue: string[] = [];

  constructor(private readonly deps: MasterLifecycleDeps) {}

  // ─── IMasterNotifier ────────────────────────────────────────────

  get handle(): RunCoderHandle | null { return this._handle; }
  get agentRunId(): number | null { return this._agentRunId; }
  get isAlive(): boolean { return !this._ended && !!this._handle?.runner; }
  get hasEnded(): boolean { return this._ended; }
  get endedWithError(): string | null { return this._endedWithError; }

  setShouldContinue(value: boolean): void {
    this._shouldContinue = value;
  }

  /** Consumed by IdleController. */
  consumeShouldContinue(): boolean {
    const v = this._shouldContinue;
    this._shouldContinue = false;
    return v;
  }

  /** Role templates — used by spawn_subordinate_agent as defaults. */
  get roleConfigs(): readonly RoleConfig[] { return this._roleConfigs; }

  updateRoleConfigs(configs: RoleConfig[]): void {
    this._roleConfigs = configs;
  }

  getRoleDefaults(role: string): { provider?: string; model?: string; tier?: string; skills?: string[] } | null {
    const cfg = this._roleConfigs.find((r) => r.role === role);
    return cfg ? { provider: cfg.provider, model: cfg.model, tier: cfg.tier, skills: cfg.skills } : null;
  }

  // ─── Notifications ──────────────────────────────────────────────

  /**
   * Notify master about a subordinate event, enriched with board context.
   * If master is alive → pushUserMessage (immediate).
   * If master is gone → resurrect with the message.
   * If master is currently resurrecting → queue for flush.
   */
  notify(message: string): void {
    const enriched = this.enrichWithBoard(message);

    if (!this._ended && this._handle?.runner && !this.resumingPromise) {
      this._handle.runner.pushUserMessage(enriched);
      return;
    }
    if (this.resumingPromise) {
      this.resumeQueue.push(enriched);
      return;
    }
    this.deps.idle.onMasterResurrected();
    void this.resurrect(enriched);
  }

  private enrichWithBoard(message: string): string {
    try {
      const recent = this.deps.ctx.companyStore.readBoard(this.deps.ctx.companySessionId, {
        sinceId: this.deps.board.lastMasterSeenId,
        limit: 30,
      });
      if (recent.length === 0) return message;
      const summary = recent
        .map((e) => `  [@${e.author_role}] (${e.kind}) ${e.content.length > 600 ? e.content.slice(0, 600) + '...' : e.content}`)
        .join('\n');
      const enriched =
        message +
        `\n\n--- Board updates since your last activity (since_id=${this.deps.board.lastMasterSeenId}) ---\n` +
        summary;
      this.deps.board.advanceMasterWatermark(recent[recent.length - 1].id);
      return enriched;
    } catch {
      return message;
    }
  }

  // ─── Start (fresh) ──────────────────────────────────────────────

  async start(opts: {
    userMessage: string;
    provider: string;
    model: string;
    maxTurns?: number;
    signal?: AbortSignal;
    roleConfigs?: RoleConfig[];
  }): Promise<RunCoderHandle> {
    if (this._handle) throw new Error('Master already started');

    const ctx = this.deps.ctx;
    const primaryProjectId = ctx.projects[0]?.project_id;
    if (!primaryProjectId) throw new Error('Company session has no linked projects');

    const config = loadConfig();
    const store = new SessionStore(config.dbPath);

    const masterSession = store.createSession({
      project_id: primaryProjectId,
      title: `[Company Master] ${ctx.companySessionId}`,
      provider: opts.provider,
      model: opts.model,
    });

    const masterRun = ctx.companyStore.createAgentRun({
      company_session_id: ctx.companySessionId,
      role: 'master',
      coder_session_id: masterSession.id,
      project_ids: ctx.projects.map((p) => p.project_id),
      provider: opts.provider,
      model: opts.model,
    });
    this._agentRunId = masterRun.id;
    this._roleConfigs = (opts.roleConfigs ?? []) as RoleConfig[];

    ctx.companyStore.setMasterSessionId(ctx.companySessionId, masterSession.id);
    ctx.companyStore.updateCompanySessionStatus(ctx.companySessionId, 'running');

    const companyContext: CompanyContext = {
      orchestrator: this.deps.orchestratorRef as never,
      companySessionId: ctx.companySessionId,
      agentRole: 'master',
      agentRunId: masterRun.id,
      allowedProjectIds: ctx.projects.map((p) => p.project_id),
      isMaster: true,
    };

    const projectInfos = ctx.projects.map((p) => {
      const proj = ctx.db.getProject(p.project_id);
      return {
        id: p.project_id,
        name: proj?.name ?? `project-${p.project_id}`,
        rootPath: proj?.root_path ?? '',
        label: p.label ?? undefined,
      };
    });

    const promptBlock = buildMasterCompanyBlock({
      roster: opts.roleConfigs ?? [],
      projects: projectInfos,
    });

    this._companyContext = companyContext;
    this._promptBlock = promptBlock;

    this.deps.board.post('human', null, 'message', opts.userMessage);
    this.deps.board.post('system', null, 'message',
      `Master agent started (${opts.provider}/${opts.model}). Analyzing task...`);

    const handle = await runCoder({
      session: { id: masterSession.id },
      userMessage: opts.userMessage,
      maxTurns: opts.maxTurns ?? 100,
      signal: opts.signal,
      planMode: false,
      profile: 'full',
      companyContext,
      companyPromptBlock: promptBlock,
    } as RunCoderOptions & { companyPromptBlock: string });

    this._handle = handle;
    this.wireAll(handle, masterRun.id);
    this.attachCompletionHandler(handle, masterRun.id);

    store.close();
    return handle;
  }

  // ─── Resume existing (cold-start) ───────────────────────────────

  async resumeExisting(opts: {
    userMessage: string;
    maxTurns?: number;
    roleConfigs?: RoleConfig[];
  }): Promise<RunCoderHandle> {
    if (this._handle) throw new Error('Master already started');

    const ctx = this.deps.ctx;
    const agentRuns = ctx.companyStore.listAgentRuns(ctx.companySessionId);
    const masterRun = agentRuns.filter((r) => r.role === 'master').pop();
    if (!masterRun) throw new Error('No master agent_run found — use start instead');

    this._agentRunId = masterRun.id;
    this._roleConfigs = (opts.roleConfigs ?? []) as RoleConfig[];

    ctx.companyStore.updateAgentRunStatus(masterRun.id, 'running');
    ctx.companyStore.updateCompanySessionStatus(ctx.companySessionId, 'running');

    const companyContext: CompanyContext = {
      orchestrator: this.deps.orchestratorRef as never,
      companySessionId: ctx.companySessionId,
      agentRole: 'master',
      agentRunId: masterRun.id,
      allowedProjectIds: ctx.projects.map((p) => p.project_id),
      isMaster: true,
    };

    const projectInfos = ctx.projects.map((p) => {
      const proj = ctx.db.getProject(p.project_id);
      return {
        id: p.project_id,
        name: proj?.name ?? `project-${p.project_id}`,
        rootPath: proj?.root_path ?? '',
        label: p.label ?? undefined,
      };
    });

    const promptBlock = buildMasterCompanyBlock({
      roster: opts.roleConfigs ?? [],
      projects: projectInfos,
    });

    this._companyContext = companyContext;
    this._promptBlock = promptBlock;

    this.deps.board.post('system', null, 'message',
      `Master resumed from existing session (${masterRun.provider}/${masterRun.model}).`);

    const handle = await runCoder({
      session: { id: masterRun.coder_session_id },
      userMessage: opts.userMessage,
      maxTurns: opts.maxTurns ?? 100,
      planMode: false,
      profile: 'full',
      companyContext,
      companyPromptBlock: promptBlock,
    } as RunCoderOptions & { companyPromptBlock: string });

    this._handle = handle;
    this.wireAll(handle, masterRun.id);
    this.attachCompletionHandler(handle, masterRun.id);

    return handle;
  }

  // ─── Resurrection (subordinate finished after master exited) ───

  private async resurrect(message: string): Promise<void> {
    if (!this._handle || !this._companyContext || !this._agentRunId) return;
    if (this.deps.ctx.isAborted || this.deps.ctx.isBusEnded) return;

    if (this.resumingPromise) {
      this.resumeQueue.push(message);
      return this.resumingPromise;
    }

    const doResume = async () => {
      this.deps.status.setStatus(this._agentRunId!, 'running');

      this.deps.board.post('system', null, 'message',
        'Master reactivated — subordinate reported completion.');

      const masterSessionId = this._handle!.session?.id;
      if (!masterSessionId) {
        console.warn('[company] resurrect: no master session id');
        return;
      }

      const handle = await runCoder({
        session: { id: masterSessionId },
        userMessage: message,
        maxTurns: 40,
        planMode: false,
        profile: 'full',
        companyContext: this._companyContext!,
        companyPromptBlock: this._promptBlock,
      } as RunCoderOptions & { companyPromptBlock: string });

      this._ended = false;
      this._endedWithError = null;
      this._handle = { ...this._handle!, runner: handle.runner, done: handle.done };
      this.wireAll(handle, this._agentRunId!);

      // Flush queued messages that arrived during spin-up.
      const queued = this.resumeQueue.splice(0, this.resumeQueue.length);
      for (const msg of queued) handle.runner.pushUserMessage(msg);

      this.attachCompletionHandler(handle, this._agentRunId!);
    };

    this.resumingPromise = doResume().finally(() => { this.resumingPromise = null; });
    return this.resumingPromise;
  }

  // ─── Live operations ────────────────────────────────────────────

  /** Swap provider on the live master runner. */
  async swapProvider(providerName: string, model?: string): Promise<{ provider: string; model: string }> {
    const newProvider = await createCoderProvider(providerName, model);
    if (this._handle && !this._ended) {
      this._handle.runner.swapProvider(newProvider);
    }
    return { provider: newProvider.name, model: newProvider.model };
  }

  /**
   * Forward a human message to the master. If the master is alive,
   * pushUserMessage; otherwise resurrect the session with the message.
   */
  sendUserMessage(message: string): boolean {
    this.deps.board.post('human', null, 'message', message);
    this.deps.idle.onUserMessageReceived();

    if (!this._ended && this._handle?.runner) {
      this._handle.runner.pushUserMessage(message);
      return true;
    }
    try {
      this.deps.ctx.companyStore.updateCompanySessionStatus(
        this.deps.ctx.companySessionId,
        'running',
      );
    } catch { /* ignore */ }
    void this.resurrect(message);
    return true;
  }

  abort(): void {
    if (this._handle) {
      this._handle.runner.abort();
      if (this._agentRunId) {
        this.deps.status.setStatus(this._agentRunId, 'aborted');
      }
    }
  }

  // ─── Internal ───────────────────────────────────────────────────

  private wireAll(handle: RunCoderHandle, runId: number): void {
    this.deps.wirer.wire(handle, 'master', runId);
    this.deps.humanInLoop.wireMasterPlan(handle);
    this.deps.humanInLoop.wireMasterQuestion(handle);
  }

  private attachCompletionHandler(handle: RunCoderHandle, runId: number): void {
    handle.done
      .then(({ reason, error }) => {
        const detail = error ? ` — ${error}` : '';
        try {
          this.deps.ctx.companyStore.updateAgentRunStatus(
            runId,
            reason === 'completed' ? 'completed' : 'error',
            reason !== 'completed' ? `${reason}${detail}` : undefined,
          );
        } catch { /* ignore */ }
        if (reason !== 'completed') {
          this._endedWithError = `${reason}${detail}`;
        }
        this.deps.board.post('system', null, 'message', `Master finished: ${reason}${detail}`);
      })
      .catch((err) => {
        try {
          this.deps.ctx.companyStore.updateAgentRunStatus(runId, 'error');
        } catch { /* ignore */ }
        this._endedWithError = err?.message ?? String(err);
        this.deps.board.post('system', null, 'message',
          `Master error: ${err?.message ?? String(err)}`);
      })
      .finally(() => {
        this._ended = true;
        this.deps.idle.onMasterEnded();
      });
  }
}
