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

import { runCoder, type CoderAttachment, type RunCoderOptions, type RunCoderHandle } from '@mcp/code-agent/index.js';
import type { CoderRunner } from '@mcp/code-agent/core/runner.js';
import { attachmentsToBlocks } from '@mcp/code-agent/core/messages.js';
import { createCoderProvider } from '@mcp/services/providers/factory.js';
import { SessionStore } from '@mcp/code-agent/sessions/store.js';
import { SkillStore } from '@mcp/store/skill-store.js';
import { loadConfig } from '@mcp/shared/utils/config.js';
import { buildMasterCompanyBlock, type MasterPromptContext } from '@mcp/company/system-prompts.js';
import type { AllowedModel, CompanyContext } from '@mcp/company/types.js';
import type { SessionContext } from '@mcp/company/services/SessionContext.js';
import type { HumanInTheLoop } from '@mcp/company/services/HumanInTheLoop.js';
import type { MasterAttention } from '@mcp/company/services/MasterAttention.js';
import type {
  IAgentStatusUpdater,
  IBoardPoster,
  IIdleController,
  IMasterNotifier,
  IMetaBusWirer,
} from '@mcp/company/services/ports.js';

import { resolveRoleSkills, type RoleSkills } from '@mcp/company/types.js';

export type RoleConfig = {
  role: string;
  provider: string;
  model: string;
  tier: string;
  projectHints?: string[];
  /** Either a flat list of skill IDs or a `RoleSkillsConfig` object with
   *  `primary`/`chain`/`conditional`. Resolved via `resolveRoleSkills`
   *  before use. */
  skills?: RoleSkills;
  systemPromptOverride?: string;
  /**
   * Concrete project ids this role is bound to in THIS session.
   * Set via the "Agents per project" UI; used by `SubordinateLifecycle.spawn`
   * for auto-resolve (when length === 1) and enforcement (rejects spawns to
   * project ids outside this list).
   */
  projectIds?: number[];
  /** Per-role sampling temperature (forwarded to the runner via
   *  `SubordinateLifecycle.spawn`). See `CompanyRoleConfig.temperature`. */
  temperature?: number;
};

function buildPromptRoster(
  configs: readonly RoleConfig[],
  stack: string | null | undefined,
): MasterPromptContext['roster'] {
  return configs.map((cfg) => ({
    role: cfg.role,
    provider: cfg.provider,
    model: cfg.model,
    tier: cfg.tier,
    projectHints: cfg.projectHints,
    projectIds: cfg.projectIds,
    skills: resolveRoleSkills(cfg.skills, { stack: stack ?? undefined }),
    systemPromptOverride: cfg.systemPromptOverride,
  }));
}

export interface MasterLifecycleDeps {
  ctx: SessionContext;
  board: IBoardPoster;
  status: IAgentStatusUpdater;
  humanInLoop: HumanInTheLoop;
  wirer: IMetaBusWirer;
  idle: IIdleController;
  /** Bus of subordinate-attention events (question/plan/tasks/finished). */
  attention: MasterAttention;
  /** Facade handed to runCoder so tools can reach the orchestrator. */
  orchestratorRef: unknown;
}

export class MasterLifecycle implements IMasterNotifier {
  private _handle: RunCoderHandle | null = null;
  private _agentRunId: number | null = null;
  private _ended = false;
  /**
   * Set as soon as `handle.done` settles (in `.then`/`.catch`), one microtask
   * before `_ended` is set in `.finally`. Closes the race between the runner's
   * `run()` returning and `attachCompletionHandler` marking the master as
   * ended: while in that window `_handle?.runner` is still truthy and
   * `_ended` is false, but the run loop will never consume `pushUserMessage`
   * again. `notify` checks both flags to route subordinate notifications
   * to `resurrect` instead of dropping them into a dead buffer.
   */
  private _runnerExited = false;
  private _endedWithError: string | null = null;
  private _companyContext: CompanyContext | null = null;
  private _promptBlock = '';
  /** Unsubscribe from the permanent `MasterAttention` listener wired in `wireAllForRunner`. */
  private _attentionOff: (() => void) | null = null;

  private _roleConfigs: RoleConfig[] = [];
  /**
   * Curated pool of (provider, model) tuples the master is allowed to
   * spawn subordinates with. Loaded from `CompanySession.config_json`
   * on start()/resumeExisting(). Empty = no restriction (backward
   * compat for sessions that predate this feature).
   */
  private _allowedModels: AllowedModel[] = [];

  /** Flag consumed by IdleController to trigger auto-continue. */
  private _shouldContinue = false;

  /**
   * Buffer of attachments from the user's most recent message. Set by
   * `start`, `resumeExisting`, and `sendUserMessage`; overwritten on each
   * new user turn (including with []). Master tools (`spawn_subordinate_agent`,
   * `forward_to_agent`) read this when the master sets `forward_user_attachments=true`,
   * so images can be propagated to subordinates without the master spending
   * tokens base64-encoding them into JSON tool arguments.
   */
  private _lastUserAttachments: CoderAttachment[] = [];

  // Resurrection concurrency
  private resumingPromise: Promise<void> | null = null;
  private resumeQueue: Array<{ message: string; attachments?: CoderAttachment[] }> = [];

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

  /**
   * Attachments from the user's most recent turn. Read-only — does not
   * clear on read so the master can forward the same images to multiple
   * subordinates in the same turn.
   */
  getLastUserAttachments(): readonly CoderAttachment[] { return this._lastUserAttachments; }

  updateRoleConfigs(configs: RoleConfig[]): void {
    this._roleConfigs = configs;
  }

  getRoleDefaults(role: string): { provider?: string; model?: string; tier?: string; skills?: RoleSkills; systemPromptOverride?: string; projectIds?: number[]; temperature?: number } | null {
    const cfg = this._roleConfigs.find((r) => r.role === role);
    return cfg ? { provider: cfg.provider, model: cfg.model, tier: cfg.tier, skills: cfg.skills, systemPromptOverride: cfg.systemPromptOverride, projectIds: cfg.projectIds, temperature: cfg.temperature } : null;
  }

  /** Current allowed-models pool. Empty array = no restriction. */
  getAllowedModels(): readonly AllowedModel[] {
    return this._allowedModels;
  }

  /**
   * When the master calls spawn without explicit provider/model AND the
   * role isn't in the template, pick a sensible default from the pool:
   *   1. Entry marked `is_default: true`
   *   2. First entry
   *   3. null when the pool is empty (caller falls back to hardcoded)
   */
  getPoolDefault(): AllowedModel | null {
    if (this._allowedModels.length === 0) return null;
    return (
      this._allowedModels.find((m) => m.is_default) ??
      this._allowedModels[0] ??
      null
    );
  }

  /**
   * Parse `CompanySession.config_json` and populate `_roleConfigs`
   * (legacy field) + `_allowedModels` (new). Called from start() and
   * resumeExisting() so the master sees the same constraints across
   * a server restart.
   */
  private loadConfigFromDb(): void {
    const ctx = this.deps.ctx;
    const row = ctx.companyStore.getCompanySession(ctx.companySessionId);
    if (!row?.config_json) return;
    try {
      const cfg = JSON.parse(row.config_json) as {
        role_assignments?: RoleConfig[];
        allowed_models?: AllowedModel[];
      };
      if (Array.isArray(cfg.allowed_models)) {
        this._allowedModels = cfg.allowed_models.filter(
          (m) => typeof m.provider === 'string' && typeof m.model === 'string',
        );
      }
      // Merge DB-persisted role_assignments with whatever opts provided.
      // opts.roleConfigs (set before this call) wins for roles present in
      // both, but DB-only roles are kept — covers the case where a template
      // was configured but stream.ts was given a subset.
      if (Array.isArray(cfg.role_assignments) && cfg.role_assignments.length > 0) {
        const seen = new Set(this._roleConfigs.map((r) => r.role));
        for (const r of cfg.role_assignments) {
          if (r && typeof r.role === 'string' && !seen.has(r.role)) {
            this._roleConfigs.push(r);
            seen.add(r.role);
          }
        }
      }
    } catch (e) {
      console.warn(
        `[master] config_json parse failed for session=${ctx.companySessionId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
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

    if (this.resumingPromise) {
      this.resumeQueue.push({ message: enriched });
      return;
    }
    // Route to resurrect not just on `_ended` but also when the run loop
    // already returned (`_runnerExited`) — otherwise pushUserMessage drops
    // the notification into a buffer that will never be flushed.
    if (!this._ended && !this._runnerExited && this._handle?.runner) {
      const runner = this._handle.runner;
      // Defensive interrupt: if the master is blocked inside a
      // `waitForUserInput` (ask_user, submit_plan), pushUserMessage queues
      // the notification but the wait never wakes on its own. Breaking the
      // wait lets the blocked tool return and the next turn consume the
      // queued message. Mirrors what HumanInTheLoop already does explicitly
      // for plan/question/tasks — centralized here so completion and
      // failure paths (which historically forgot to call interruptWait)
      // benefit automatically.
      if (runner.isWaitingForInput()) {
        runner.interruptWait({ kind: 'subordinate_event' });
      }
      runner.pushUserMessage(enriched);
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
    attachments?: CoderAttachment[];
    /** Enable extended thinking on the master's first turn (and subsequent turns until toggled off). */
    thinking?: boolean;
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
    // Populate `_allowedModels` from the persisted session config. Must
    // happen before any `spawn_subordinate_agent` call, so we do it
    // here (start + resume) alongside role configs.
    this.loadConfigFromDb();

    const orchestrator = this.deps.orchestratorRef as unknown as {
      provisionSandboxIfNeeded?: (signal?: AbortSignal) => Promise<import('@mcp/company/types.js').SandboxBinding | null>;
      getSandboxStackForService?: (serviceId?: string | null) => string | null;
    };
    const configuredStack = orchestrator.getSandboxStackForService?.() ?? null;

    ctx.companyStore.setMasterSessionId(ctx.companySessionId, masterSession.id);
    ctx.companyStore.updateCompanySessionStatus(ctx.companySessionId, 'running');

    const masterRoleConfig = this._roleConfigs.find((r) => r.role === 'master');
    const masterResolvedSkills = resolveRoleSkills(masterRoleConfig?.skills, {
      stack: configuredStack ?? undefined,
    });
    if (masterResolvedSkills.length > 0) {
      try {
        const skillStore = new SkillStore(config.dbPath);
        const allSkills = skillStore.resolveActiveSkills(masterSession.id, primaryProjectId);
        for (const skill of allSkills) {
          skillStore.setSessionSkillEnabled(masterSession.id, skill.id, masterResolvedSkills.includes(skill.id));
        }
        skillStore.close();
      } catch (e) {
        console.warn(`[company] Failed to configure skills for master: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Builder mode: provision the sandbox BEFORE runCoder so the binding
    // can be woven into the master's CompanyContext. For non-builder
    // sessions this call is a no-op that returns null (the SandboxService
    // inspects `config_json.builder` and bails out cleanly).
    // SandboxService.provisionIfNeeded never throws — it returns null when
    // the container can't be started, so the master always starts.
    const sandboxBinding = orchestrator.provisionSandboxIfNeeded
      ? await orchestrator.provisionSandboxIfNeeded(opts.signal)
      : null;

    // Read the configured stack from the session config (DB-backed, works
    // even when the primary container is not running). Non-null means the
    // session is in builder mode regardless of container status.

    const companyContext: CompanyContext = {
      orchestrator: this.deps.orchestratorRef as never,
      companySessionId: ctx.companySessionId,
      agentRole: 'master',
      agentRunId: masterRun.id,
      allowedProjectIds: ctx.projects.map((p) => p.project_id),
      isMaster: true,
      sandbox: sandboxBinding ?? undefined,
      builderStack: configuredStack ?? undefined,
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
      roster: buildPromptRoster(this._roleConfigs, configuredStack),
      projects: projectInfos,
      // Builder-mode awareness: tell the master it's in a builder session
      // and which files are MCP-managed. When the primary container is
      // down (sandboxBinding null) we still pass the stack so the master
      // knows it's a builder session — workdir/previewUrl are omitted and
      // buildBuilderInstructions renders a degraded but useful block.
      builder: configuredStack
        ? {
            workdir: sandboxBinding?.workdir,
            stack: orchestrator.getSandboxStackForService?.() ?? configuredStack,
            previewUrl: sandboxBinding?.previewUrl,
          }
        : undefined,
      // Curated pool — when non-empty, the master prompt gains a strict
      // "ALLOWED SUBORDINATE MODELS" section + tool rejection guidance.
      allowedModels: this._allowedModels.length > 0 ? this._allowedModels : undefined,
    });

    this._companyContext = companyContext;
    this._promptBlock = promptBlock;

    this._lastUserAttachments = opts.attachments ?? [];
    const startBoardMsg = opts.attachments && opts.attachments.length > 0
      ? `${opts.userMessage}\n\n_[${opts.attachments.length} ${opts.attachments.length === 1 ? 'attachment' : 'attachments'}]_`
      : opts.userMessage;
    this.deps.board.post('human', null, 'message', startBoardMsg);
    this.deps.board.post('system', null, 'message',
      `Master agent started (${opts.provider}/${opts.model}). Analyzing task...`);

    const handle = await runCoder({
      session: { id: masterSession.id },
      userMessage: opts.userMessage,
      attachments: opts.attachments,
      maxTurns: opts.maxTurns ?? 100,
      signal: opts.signal,
      planMode: false,
      profile: 'full',
      companyContext,
      companyPromptBlock: promptBlock,
      thinking: opts.thinking,
      // Wire HumanInTheLoop BEFORE the runner takes turn 1, so a master
      // that calls `ask_user` immediately is still captured. Without
      // this, the prompt is created in the runner but the
      // `question_posted` listener doesn't exist yet → the question is
      // silently lost and the master blocks forever.
      onRunnerReady: (runner) => this.wireAllForRunner(runner, masterRun.id),
    } as RunCoderOptions & { companyPromptBlock: string });

    this._handle = handle;
    this._runnerExited = false;
    this.attachCompletionHandler(handle, masterRun.id);

    store.close();
    return handle;
  }

  // ─── Resume existing (cold-start) ───────────────────────────────

  async resumeExisting(opts: {
    userMessage: string;
    maxTurns?: number;
    roleConfigs?: RoleConfig[];
    attachments?: CoderAttachment[];
    /** Enable extended thinking on the resumed master's next turn. */
    thinking?: boolean;
  }): Promise<RunCoderHandle> {
    if (this._handle) throw new Error('Master already started');

    const ctx = this.deps.ctx;
    const agentRuns = ctx.companyStore.listAgentRuns(ctx.companySessionId);
    const masterRun = agentRuns.filter((r) => r.role === 'master').pop();
    if (!masterRun) throw new Error('No master agent_run found — use start instead');

    this._agentRunId = masterRun.id;
    this._roleConfigs = (opts.roleConfigs ?? []) as RoleConfig[];
    // Populate `_allowedModels` from the persisted session config. Must
    // happen before any `spawn_subordinate_agent` call, so we do it
    // here (start + resume) alongside role configs.
    this.loadConfigFromDb();

    const orchestratorResume = this.deps.orchestratorRef as unknown as {
      provisionSandboxIfNeeded?: () => Promise<import('@mcp/company/types.js').SandboxBinding | null>;
      getSandboxStackForService?: (serviceId?: string | null) => string | null;
    };
    const configuredStackResume = orchestratorResume.getSandboxStackForService?.() ?? null;

    ctx.companyStore.updateAgentRunStatus(masterRun.id, 'running');
    ctx.companyStore.updateCompanySessionStatus(ctx.companySessionId, 'running');

    const masterRoleConfigResume = this._roleConfigs.find((r) => r.role === 'master');
    const masterResolvedSkillsResume = resolveRoleSkills(masterRoleConfigResume?.skills, {
      stack: configuredStackResume ?? undefined,
    });
    if (masterResolvedSkillsResume.length > 0) {
      const resumeConfig = loadConfig();
      const primaryProjectIdResume = ctx.projects[0]?.project_id;
      if (primaryProjectIdResume) {
        try {
          const skillStore = new SkillStore(resumeConfig.dbPath);
          const allSkills = skillStore.resolveActiveSkills(masterRun.coder_session_id, primaryProjectIdResume);
          for (const skill of allSkills) {
            skillStore.setSessionSkillEnabled(masterRun.coder_session_id, skill.id, masterResolvedSkillsResume.includes(skill.id));
          }
          skillStore.close();
        } catch (e) {
          console.warn(`[company] Failed to configure skills for master (resume): ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    // Same builder-provisioning hook as `start()` — resumes that were
    // kicked off in builder mode get their sandbox re-provisioned here
    // (the manager's in-memory state is lost on API restart, so the
    // container is rebuilt fresh; persisting workdir contents across
    // restarts is a Phase 5 item).
    // SandboxService.provisionIfNeeded never throws — returns null when
    // the container can't start, so the master always resumes.
    const sandboxBindingResume = orchestratorResume.provisionSandboxIfNeeded
      ? await orchestratorResume.provisionSandboxIfNeeded()
      : null;

    // DB-backed stack config — non-null means builder mode regardless of
    // whether the container is currently running.

    const companyContext: CompanyContext = {
      orchestrator: this.deps.orchestratorRef as never,
      companySessionId: ctx.companySessionId,
      agentRole: 'master',
      agentRunId: masterRun.id,
      allowedProjectIds: ctx.projects.map((p) => p.project_id),
      isMaster: true,
      sandbox: sandboxBindingResume ?? undefined,
      builderStack: configuredStackResume ?? undefined,
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
      roster: buildPromptRoster(this._roleConfigs, configuredStackResume),
      projects: projectInfos,
      builder: configuredStackResume
        ? {
            workdir: sandboxBindingResume?.workdir,
            stack: orchestratorResume.getSandboxStackForService?.() ?? configuredStackResume,
            previewUrl: sandboxBindingResume?.previewUrl,
          }
        : undefined,
      allowedModels: this._allowedModels.length > 0 ? this._allowedModels : undefined,
    });

    this._companyContext = companyContext;
    this._promptBlock = promptBlock;

    this._lastUserAttachments = opts.attachments ?? [];
    this.deps.board.post('system', null, 'message',
      `Master resumed from existing session (${masterRun.provider}/${masterRun.model}).`);

    const handle = await runCoder({
      session: { id: masterRun.coder_session_id },
      userMessage: opts.userMessage,
      attachments: opts.attachments,
      maxTurns: opts.maxTurns ?? 100,
      planMode: false,
      profile: 'full',
      companyContext,
      companyPromptBlock: promptBlock,
      thinking: opts.thinking,
      onRunnerReady: (runner) => this.wireAllForRunner(runner, masterRun.id),
    } as RunCoderOptions & { companyPromptBlock: string });

    this._handle = handle;
    this._runnerExited = false;
    this.attachCompletionHandler(handle, masterRun.id);

    return handle;
  }

  // ─── Resurrection (subordinate finished after master exited) ───

  private async resurrect(message: string, attachments?: CoderAttachment[], thinking?: boolean): Promise<void> {
    if (!this._handle || !this._companyContext || !this._agentRunId) return;
    if (this.deps.ctx.isAborted || this.deps.ctx.isBusEnded) return;

    if (this.resumingPromise) {
      this.resumeQueue.push({ message, attachments });
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
        attachments,
        maxTurns: 40,
        planMode: false,
        profile: 'full',
        companyContext: this._companyContext!,
        companyPromptBlock: this._promptBlock,
        thinking,
        onRunnerReady: (runner) => this.wireAllForRunner(runner, this._agentRunId!),
      } as RunCoderOptions & { companyPromptBlock: string });

      this._ended = false;
      this._runnerExited = false;
      this._endedWithError = null;
      this._handle = { ...this._handle!, runner: handle.runner, done: handle.done };

      // Flush queued messages that arrived during spin-up.
      const queued = this.resumeQueue.splice(0, this.resumeQueue.length);
      for (const item of queued) {
        if (item.attachments?.length) {
          handle.runner.pushUserContent(attachmentsToBlocks(item.message, item.attachments));
        } else {
          handle.runner.pushUserMessage(item.message);
        }
      }

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
   *
   * When the master is alive but currently blocked inside an interactive
   * tool (`wait_for_subordinates` / `ask_user` / `submit_plan`), the
   * pushed message would otherwise sit in the runner's pendingUserMessages
   * buffer until something else wakes the wait. With `interject: true`
   * we break the wait first (the blocked tool receives `{ interrupted: true }`
   * and reports an error so the master can react), then push the message.
   *
   * Returns a structured result so the HTTP layer can distinguish "queued"
   * from "interaction pending — caller must opt-in to override".
   */
  sendUserMessage(
    message: string,
    options: { interject?: boolean; attachments?: CoderAttachment[]; thinking?: boolean } = {},
  ): { ok: boolean; pending?: 'interactive_wait' } {
    const attachments = options.attachments;
    this._lastUserAttachments = attachments ?? [];
    const boardMessage = attachments && attachments.length > 0
      ? `${message}\n\n_[${attachments.length} ${attachments.length === 1 ? 'attachment' : 'attachments'}]_`
      : message;
    this.deps.board.post('human', null, 'message', boardMessage);
    this.deps.idle.onUserMessageReceived();

    if (!this._ended && this._handle?.runner) {
      const runner = this._handle.runner;
      if (runner.isWaitingForInput()) {
        if (!options.interject) {
          return { ok: false, pending: 'interactive_wait' };
        }
        runner.interruptWait();
      }
      // Apply thinking BEFORE pushing the message so the next turn (which
      // consumes this message) reads the updated flag from `this.opts.thinking`.
      if (options.thinking !== undefined) runner.setThinking(options.thinking);
      if (attachments && attachments.length > 0) {
        runner.pushUserContent(attachmentsToBlocks(message, attachments));
      } else {
        runner.pushUserMessage(message);
      }
      return { ok: true };
    }
    try {
      this.deps.ctx.companyStore.updateCompanySessionStatus(
        this.deps.ctx.companySessionId,
        'running',
      );
    } catch { /* ignore */ }
    void this.resurrect(message, attachments, options.thinking);
    return { ok: true };
  }

  abort(): void {
    if (this._handle) {
      try { this._handle.runner.abort(); } catch { /* best-effort */ }
      if (this._agentRunId) {
        try { this.deps.status.setStatus(this._agentRunId, 'aborted'); } catch { /* best-effort */ }
      }
    }
    // Hard-end so a stray `sendUserMessage` after abort doesn't resurrect
    // the master via the lazy-start path.
    this._ended = true;
    this._endedWithError = this._endedWithError ?? 'aborted';
  }

  // ─── Internal ───────────────────────────────────────────────────

  /**
   * Wire HumanInTheLoop + meta-bus listeners onto the runner. Called
   * via `runCoder({ onRunnerReady })` BEFORE the runner takes its first
   * turn — otherwise an `ask_user` made on turn 1 emits `question_posted`
   * before any listener exists and the prompt is silently lost (master
   * stays blocked in `waitForUserInput` with no `master_prompts` row to
   * resolve). Accepts `runner` directly because at call time we don't
   * have a full `RunCoderHandle` yet.
   */
  private wireAllForRunner(runner: CoderRunner, runId: number): void {
    const synthetic = { runner } as unknown as RunCoderHandle;
    this.deps.wirer.wire(synthetic, 'master', runId);
    this.deps.humanInLoop.wireMasterPlan(synthetic);
    this.deps.humanInLoop.wireMasterQuestion(synthetic);

    // Permanent attention listener: every subordinate transition
    // (question/plan/tasks/finished) interrupts a pending waitForUserInput
    // on the master so the message enqueued by `master.notify` actually gets
    // consumed in the next turn. Without this, a sub that finishes while
    // the master is blocked in `ask_user`/`submit_plan` would sit unread
    // until the human responded — sometimes never. Mirrors the per-tool
    // unsubscribe pattern in `wait_for_subordinates` but persists for the
    // master's entire lifetime; cleaned up in `attachCompletionHandler.finally`.
    if (this._attentionOff) {
      try { this._attentionOff(); } catch { /* best-effort */ }
    }
    this._attentionOff = this.deps.attention.on((ev) => {
      if (ev.kind === 'inbox_answered') return;
      if (this._ended || this._runnerExited) return;
      if (runner.isWaitingForInput()) {
        runner.interruptWait({
          kind: ev.kind === 'finished' ? 'subordinate_event' : ev.kind,
          agentRunId: ev.agentRunId,
          role: ev.role,
        });
      }
    });
  }

  private attachCompletionHandler(handle: RunCoderHandle, runId: number): void {
    handle.done
      .then(({ reason, error }) => {
        // Set BEFORE any further work so a subordinate notify() arriving in
        // this microtask routes to resurrect instead of pushing into a dead
        // buffer (see _runnerExited docs above).
        this._runnerExited = true;
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
        this._runnerExited = true;
        try {
          this.deps.ctx.companyStore.updateAgentRunStatus(runId, 'error');
        } catch { /* ignore */ }
        this._endedWithError = err?.message ?? String(err);
        this.deps.board.post('system', null, 'message',
          `Master error: ${err?.message ?? String(err)}`);
      })
      .finally(() => {
        this._ended = true;
        // Tear down the permanent attention listener so a stale `interruptWait`
        // doesn't fire against a dead runner during the brief window before
        // resurrect rewires a fresh one.
        if (this._attentionOff) {
          try { this._attentionOff(); } catch { /* best-effort */ }
          this._attentionOff = null;
        }
        // If the master ended while a master_prompt was still pending
        // (errored / aborted while inside ask_user or submit_plan), mark
        // those prompts as cancelled so the dashboard transitions them
        // out of "pending" instead of leaving them dangling forever.
        try {
          this.deps.humanInLoop.cancelPendingMasterPrompts();
        } catch { /* best-effort */ }
        this.deps.idle.onMasterEnded();
      });
  }
}
