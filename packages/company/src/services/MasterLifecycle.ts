import type { RoleConfig } from './master/role-config.js';
export type { RoleConfig } from './master/role-config.js';
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

import { runCoder, type CoderAttachment, type RunCoderOptions, type RunCoderHandle, type MasterStartResult } from '@mcp/code-agent/index.js';
import type { CoderRunner } from '@mcp/code-agent/core/runner.js';
import { installDocsDeepResearch } from '@mcp/docs-agent/bridges/docs-bridge.js';
import { attachmentsToBlocks } from '@mcp/code-agent/core/messages.js';
import { createCoderProvider } from '@mcp/services/providers/factory.js';
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
import type { CompanyEventBus } from '@mcp/company/services/CompanyEventBus.js';
import { parseMasterConfigFromDb } from '@mcp/company/services/master/config-loader.js';
import { enrichMessageWithBoard } from '@mcp/company/services/master/board-enrichment.js';
import {
  attachMasterCompletionHandler,
  wireMasterRunnerListeners,
  type MasterRunnerStateMutators,
} from '@mcp/company/services/master/runner-wiring.js';
import { getGlobalAgentSupervisor } from '@mcp/company/services/supervisor/global.js';
import { wireSupervisorToRunner } from '@mcp/company/services/supervisor/wire-runner-events.js';
import {
  isAutonomyActionAllowed,
  resolveAutonomy,
} from '@mcp/company/services/autonomy/autonomy-config.js';
import type { AutonomyProvider } from '@mcp/company/services/autonomy/autonomy-provider.js';
import {
  startMaster,
  type MasterStartOpts,
  type MasterRuntimeSnapshot,
  type MasterStartStateMutators,
} from '@mcp/company/services/master/start.js';
import {
  resumeMaster,
  type MasterResumeOpts,
} from '@mcp/company/services/master/resume.js';
import {
  resurrectMaster,
  type MasterResurrectStateMutators,
} from '@mcp/company/services/master/resurrect.js';
import { applyExplicitMasterFallback } from '@mcp/company/services/master/fallback.js';
import { resolveEffectiveMasterRuntime } from '@mcp/company/services/subordinate/role-runtime.js';

import { resolveRoleSkills, type RoleSkills } from '@mcp/company/types.js';


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
  /**
   * Direct `IdleController` is still accepted for back-compat with
   * callers that haven't migrated to the bus yet. When `eventBus` is
   * provided, MasterLifecycle prefers the bus and the `idle` ref becomes
   * a no-op; passing both is allowed but only the bus path actually fires.
   */
  idle?: IIdleController;
  /**
   * Phase 8 part 3: internal pub/sub used to notify `IdleController`
   * about master lifecycle transitions without holding a direct ref.
   * Optional only because some narrow test fixtures construct the
   * service without a full orchestrator harness.
   */
  eventBus?: CompanyEventBus;
  /** Bus of subordinate-attention events (question/plan/tasks/finished). */
  attention: MasterAttention;
  /** Facade handed to runCoder so tools can reach the orchestrator. */
  orchestratorRef: unknown;
  /**
   * C2 — per-session autonomy config; gates the master-supervisor wiring
   * (action `supervisor`, default ON). Optional: fixtures without it fall
   * back to `resolveAutonomy(null, process.env)` — never crash.
   */
  autonomy?: Pick<AutonomyProvider, 'get'>;
  /**
   * B3 — sandbox health watchdog, started after the master boot path
   * (which runs `provisionSandboxIfNeeded`) so probes only begin once a
   * sandbox can exist. Back-wired by `wire-services.ts` (same pattern as
   * `humanInLoop`); optional so narrow test fixtures stay untouched.
   * `start()` is idempotent.
   */
  serviceSupervisor?: { start(): void };
}

export class MasterLifecycle implements IMasterNotifier {
  private _handle: RunCoderHandle | null = null;
  private _agentRunId: string | null = null;
  private _ended = false;
  /** True while terminal persistence and prompt cleanup finish for the old runner. */
  private _runnerExited = false;
  private _endedWithError: string | null = null;
  /**
   * ISO timestamp of the most recent runner exit (set in
   * `runner-wiring.ts` `.finally`, cleared on `resurrect`). Surfaced
   * via the `session_idle` payload so the dashboard can render a
   * "Master finished at HH:MM" banner.
   */
  private _endedAt: string | null = null;
  /**
   * ISO timestamp of the most recent user message. Used by
   * `IdleController` to decide whether a runner exit is "unexpected"
   * (no recent user activity) or "completed in response to a turn".
   */
  private _lastUserMessageAt: string | null = null;
  private _companyContext: CompanyContext | null = null;
  private _promptBlock = '';
  private _roleConfigs: RoleConfig[] = [];
  /**
   * Curated pool of (provider, model) tuples the master is allowed to
   * spawn subordinates with. Loaded from `CompanySession.config_json`
   * on start()/resumeExisting(). Empty = no restriction (backward
   * compat for sessions that predate this feature).
   */
  private _allowedModels: AllowedModel[] = [];
  /** Immutable effective Master settings for resurrection/fallback cycles. */
  private _runtimeSnapshot: MasterRuntimeSnapshot = { fallbackModels: [] };

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
  // Covers the interval before cold resume has loaded its persisted Master and installed the bootstrap promise.
  private coldResumeAck: Promise<MasterStartResult> | null = null;
  private resumingPromise: Promise<void> | null = null;
  private resumeQueue: Array<{ message: string; attachments?: CoderAttachment[] }> = [];

  constructor(private readonly deps: MasterLifecycleDeps) {}

  /** Epoch ms of the most recent `resurrect()` start. 0 = never. See
   *  `resurrectedWithinMs` — the supervisor/reconciler dedup point. */
  private _lastResurrectAtMs = 0;

  // ─── IMasterNotifier ────────────────────────────────────────────

  get handle(): RunCoderHandle | null { return this._handle; }
  get agentRunId(): string | null { return this._agentRunId; }
  get isAlive(): boolean { return !this._ended && !!this._handle?.runner; }
  /**
   * True when `resurrect()` fired within the last `ms`. Single coordination
   * point so the AgentSupervisor and the RuntimeReconciler don't BOTH revive a
   * dead master in the same window (each consults this before resurrecting).
   */
  resurrectedWithinMs(ms: number): boolean {
    return this._lastResurrectAtMs > 0 && Date.now() - this._lastResurrectAtMs < ms;
  }
  get hasEnded(): boolean { return this._ended; }
  get endedWithError(): string | null { return this._endedWithError; }
  /** ISO timestamp of when the runner most recently exited. */
  get endedAt(): string | null { return this._endedAt; }
  /** ISO timestamp of when a user message most recently arrived. */
  get lastUserMessageAt(): string | null { return this._lastUserMessageAt; }
  private get closingTurn(): boolean {
    return !this._ended && (this._runnerExited || this._handle?.runner.isInputQueueClosed === true);
  }
  get hasActiveTurn(): boolean { return this.isAlive || !!this.resumingPromise || !!this.coldResumeAck; }
  get canRotateConversation(): boolean { return !this.hasActiveTurn; }

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

  getRoleDefaults(role: string): { enabled?: boolean; provider?: string; model?: string; tier?: string; skills?: RoleSkills; initialTools?: string[]; systemPromptOverride?: string; projectIds?: number[]; temperature?: number; thinking?: boolean; thinkingBudgetTokens?: number; reasoningEffort?: string; fallbackModels?: AllowedModel[] } | null {
    const cfg = this._roleConfigs.find((r) => r.role === role);
    return cfg ? {
      enabled: cfg.enabled,
      provider: cfg.provider,
      model: cfg.model,
      tier: cfg.tier,
      skills: cfg.skills,
      initialTools: cfg.initialTools,
      systemPromptOverride: cfg.systemPromptOverride,
      projectIds: cfg.projectIds,
      temperature: cfg.temperature,
      thinking: cfg.thinking,
      thinkingBudgetTokens: cfg.thinkingBudgetTokens,
      reasoningEffort: cfg.reasoningEffort,
      fallbackModels: cfg.fallbackModels,
    } : null;
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
    const row = ctx.companyFiles.getSession();
    const parsed = parseMasterConfigFromDb(
      row?.config_json ?? null,
      this._roleConfigs,
      ctx.companySessionId,
    );
    if (parsed.allowedModels.length > 0) this._allowedModels = parsed.allowedModels;
    this._roleConfigs = parsed.roleConfigs;
  }

  // ─── Notifications ──────────────────────────────────────────────

  /**
   * Notify master about a subordinate event, enriched with board context.
   * If master is alive → pushUserMessage (immediate).
   * If master is gone → resurrect with the message.
   * If master is currently resurrecting → queue for flush.
   */
  notify(message: string): void {
    if (this.deps.ctx.isAborted || this.deps.ctx.isBusEnded || this.deps.ctx.isFinalized) return;
    const enriched = this.enrichWithBoard(message);

    if (!this._ended && !this.closingTurn && this._handle?.runner) {
      const runner = this._handle.runner;
      // Deliver at the next turn boundary. Only a human response should settle a pending prompt.
      runner.pushUserMessage(enriched);
      // Wake an optional synchronous assignment after its notification is queued.
      this.deps.attention.signal({
        kind: 'notify',
        agentRunId: this._agentRunId,
        role: 'system',
      });
      return;
    }
    if (this.coldResumeAck || this.resumingPromise || this.closingTurn) {
      this.resumeQueue.push({ message: enriched });
      return;
    }
    if (!this._handle) {
      // A fresh worker may receive a specialist's result for a dormant Master.
      // Only resume a previously finished round in an active Company.
      const files = this.deps.ctx.companyFiles;
      const session = files.getSession();
      if (!session?.master_session_id || !['idle', 'running'].includes(session.status)) return;
      const run = files.listAgentRunsSync().find(r => r.role === 'master' && !r.archive_id && r.coder_session_id === session.master_session_id);
      if (run?.status !== 'completed' && run?.status !== 'waiting') return;
      this.notifyIdleResurrected();
      void this.resumeExisting({ userMessage: enriched, recordUserMessage: false }).catch(error => {
        this.deps.board.post('system', null, 'blocker', `Master resume failed: ${String(error)}`);
      });
      return;
    }
    if (this.resumeDormantAppMaster(enriched)) return;
    this.notifyIdleResurrected();
    void this.resurrect(enriched);
  }

  /** Phase 8 part 3: prefer the bus; fall back to direct ref for tests. */
  private notifyIdleResurrected(): void {
    if (this.deps.eventBus) this.deps.eventBus.emit({ type: 'master.resurrected' });
    else this.deps.idle?.onMasterResurrected();
  }
  private notifyIdleEnded(): void {
    // Deliver events received during terminal persistence to the successor runner.
    if (!this.deps.ctx.isAborted && !this.deps.ctx.isBusEnded && !this.deps.ctx.isFinalized) {
      const starting = this.resumingPromise ?? this.coldResumeAck;
      if (this.resumeQueue.length && starting) {
        // A fast runner can finish before its bootstrap releases ownership.
        void starting.then(() => {
          if (this._ended && this.resumeQueue.length) this.notifyIdleEnded();
        }, () => undefined);
        return;
      }
      const next = this.resumeQueue.shift();
      if (next) {
        this.notifyIdleResurrected();
        void this.resurrect(next.message, next.attachments);
        return;
      }
    }
    if (this.deps.eventBus) this.deps.eventBus.emit({ type: 'master.ended' });
    else this.deps.idle?.onMasterEnded();
  }
  private notifyIdleUserMessage(): void {
    // Stamp BEFORE notifying so any synchronous idle re-check that
    // reads `lastUserMessageAt` sees the fresh value.
    this._lastUserMessageAt = new Date().toISOString();
    if (this.deps.eventBus) this.deps.eventBus.emit({ type: 'user.message_received' });
    else this.deps.idle?.onUserMessageReceived();
  }

  private enrichWithBoard(message: string): string {
    return enrichMessageWithBoard({ ctx: this.deps.ctx, board: this.deps.board }, message);
  }

  // ─── Start (fresh) ──────────────────────────────────────────────

  async start(opts: MasterStartOpts): Promise<MasterStartResult> {
    let effectiveOpts = opts;
    if (this.deps.ctx.runtimeKind === 'app_studio') {
      const session = this.deps.ctx.companyFiles.getSession();
      const runtime = resolveEffectiveMasterRuntime({
        configJson: session?.config_json,
        runtimeKind: 'app_studio',
      });
      effectiveOpts = {
        ...opts,
        provider: runtime.provider,
        model: runtime.model,
        temperature: runtime.temperature,
        thinking: opts.thinking ?? runtime.thinking,
        thinkingBudgetTokens: runtime.thinkingBudgetTokens,
        reasoningEffort: runtime.reasoningEffort,
        fallbackModels: runtime.fallbackModels,
        skills: runtime.skills,
        initialTools: runtime.initialTools,
        systemPromptOverride: runtime.roleOverride,
      };
    }
    const result = await startMaster(effectiveOpts, {
      ctx: this.deps.ctx,
      board: this.deps.board,
      orchestratorRef: this.deps.orchestratorRef,
      state: this.buildStartStateMutators(),
      wireRunner: (runner, runId) => this.wireAllForRunner(runner, runId),
      attachCompletion: (handle, runId) => this.attachCompletionHandler(handle, runId),
    });
    // B3 — the boot path above kicks off `provisionSandboxIfNeeded`; from
    // here on a sandbox may exist, so arm the health watchdog (idempotent).
    this.deps.serviceSupervisor?.start();
    return result;
  }

  /** Build the state-mutator surface shared by start + resume. */
  private buildStartStateMutators(): MasterStartStateMutators {
    const self = this;
    return {
      get hasHandle() { return !!self._handle; },
      get roleConfigs() { return self._roleConfigs; },
      get allowedModels() { return self._allowedModels; },
      setAgentRunId: (id) => { self._agentRunId = id; },
      setRuntimeSnapshot: (snapshot) => { self._runtimeSnapshot = snapshot; },
      setRoleConfigs: (configs) => { self._roleConfigs = configs; },
      loadConfigFromDb: () => self.loadConfigFromDb(),
      setCompanyContext: (ctx) => { self._companyContext = ctx; },
      setPromptBlock: (block) => { self._promptBlock = block; },
      setLastUserAttachments: (atts) => { self._lastUserAttachments = atts; },
      setHandle: (handle) => { self._handle = handle; },
      setRunnerExited: (v) => { self._runnerExited = v; },
      // Shared with the resurrect path — lets the background provision phase
      // serialise against concurrent starts and flush queued turns.
      get resumingPromise() { return self.resumingPromise; },
      setResumingPromise: (p) => { self.resumingPromise = p; },
      get resumeQueue() { return self.resumeQueue; },
      drainResumeQueue: () => self.resumeQueue.splice(0, self.resumeQueue.length),
    };
  }

  // ─── Resume existing (cold-start) ───────────────────────────────

  resumeExisting(opts: MasterResumeOpts): Promise<MasterStartResult> {
    if (this.coldResumeAck) {
      this.resumeQueue.push({ message: opts.userMessage, attachments: opts.attachments });
      return this.coldResumeAck;
    }
    this.coldResumeAck = this.resumePersisted(opts).finally(() => { this.coldResumeAck = null; });
    return this.coldResumeAck;
  }

  private async resumePersisted(opts: MasterResumeOpts): Promise<MasterStartResult> {
    let effectiveOpts = opts;
    if (this.deps.ctx.runtimeKind === 'app_studio') {
      const session = this.deps.ctx.companyFiles.getSession();
      const runtime = resolveEffectiveMasterRuntime({
        configJson: session?.config_json,
        runtimeKind: 'app_studio',
      });
      effectiveOpts = {
        ...opts,
        provider: runtime.provider,
        model: runtime.model,
        temperature: runtime.temperature,
        thinking: opts.thinking ?? runtime.thinking,
        thinkingBudgetTokens: runtime.thinkingBudgetTokens,
        reasoningEffort: runtime.reasoningEffort,
        fallbackModels: runtime.fallbackModels,
        skills: runtime.skills,
        initialTools: runtime.initialTools,
        systemPromptOverride: runtime.roleOverride,
      };
    }
    const result = await resumeMaster(effectiveOpts, {
      ctx: this.deps.ctx,
      board: this.deps.board,
      orchestratorRef: this.deps.orchestratorRef,
      state: this.buildStartStateMutators(),
      wireRunner: (runner, runId) => this.wireAllForRunner(runner, runId),
      attachCompletion: (handle, runId) => this.attachCompletionHandler(handle, runId),
    });
    // B3 — cold-started sessions may already own live containers.
    this.deps.serviceSupervisor?.start();
    return result;
  }

  /**
   * Forget only the dormant Master runner after App Studio rotates its
   * coordinator conversation. Subordinates, inbox, scheduler and sandbox stay
   * attached to the same Company session; the next user message cold-resumes
   * the newest persisted master agent_run.
   */
  rotateToPersistedMaster(): boolean {
    if (!this.canRotateConversation) return false;
    if (this._agentRunId != null) {
      try { this.deps.humanInLoop.clearForAgent(this._agentRunId); } catch { /* best-effort */ }
    }
    this._handle = null;
    this._agentRunId = null;
    this._ended = false;
    this._runnerExited = false;
    this._endedWithError = null;
    this._endedAt = null;
    this._companyContext = null;
    this._promptBlock = '';
    this._lastUserAttachments = [];
    this.resumeQueue.splice(0, this.resumeQueue.length);
    return true;
  }

  // ─── Resurrection (subordinate finished after master exited) ───

  private async resurrect(
    message: string,
    attachments?: CoderAttachment[],
    thinking?: boolean,
  ): Promise<void> {
    // Stamp BEFORE the async work so a concurrent watcher sees the in-flight
    // resurrect and defers (resurrectedWithinMs) instead of starting a second.
    this._lastResurrectAtMs = Date.now();
    return resurrectMaster(message, attachments, thinking, {
      ctx: this.deps.ctx,
      status: this.deps.status,
      board: this.deps.board,
      state: this.buildResurrectStateMutators(),
      wireRunner: (runner, runId) => this.wireAllForRunner(runner, runId),
      attachCompletion: (handle, runId) => this.attachCompletionHandler(handle, runId),
    });
  }

  /**
   * App role edits are next-dispatch settings. When a dormant Master wakes,
   * discard only its ended in-memory runner and enter the cold-resume path so
   * provider/model, reasoning, prompt and skills are resolved from the latest
   * persisted App team config. Specialists and the Company session survive.
   */
  private resumeDormantAppMaster(
    message: string,
    attachments?: CoderAttachment[],
    thinking?: boolean,
  ): boolean {
    if (this.deps.ctx.runtimeKind !== 'app_studio' || this.isAlive) return false;
    if (!this.rotateToPersistedMaster()) return false;
    this.notifyIdleResurrected();
    void this.resumeExisting({
      userMessage: message,
      attachments,
      thinking,
    }).catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      try {
        this.deps.board.post('system', null, 'blocker', `Master resume failed: ${detail}`);
      } catch { /* best-effort */ }
    });
    return true;
  }

  /** Build the state-mutator surface used by the resurrect helper. */
  private buildResurrectStateMutators(): MasterResurrectStateMutators {
    const self = this;
    return {
      get handle() { return self._handle; },
      get companyContext() { return self._companyContext; },
      get promptBlock() { return self._promptBlock; },
      get agentRunId() { return self._agentRunId; },
      get runtimeSnapshot() { return self._runtimeSnapshot; },
      get resumingPromise() { return self.resumingPromise; },
      setResumingPromise: (p) => { self.resumingPromise = p; },
      get resumeQueue() { return self.resumeQueue; },
      drainResumeQueue: () => self.resumeQueue.splice(0, self.resumeQueue.length),
      refreshHandle: (runner, done) => {
        if (self._handle) self._handle = { ...self._handle, runner, done };
      },
      setEnded: (v) => { self._ended = v; },
      setRunnerExited: (v) => { self._runnerExited = v; },
      setEndedWithError: (v) => { self._endedWithError = v; },
      setEndedAt: (v) => { self._endedAt = v; },
    };
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
   * When the master is blocked in a `waitForUserInput`-based tool
   * (`ask_user` / `submit_plan`), the pushed message would otherwise sit
   * in the runner's pendingUserMessages buffer until something else wakes
   * the wait. With `interject: true` we break that wait first (the blocked
   * tool receives `{ interrupted: true }` and reports an error so the master
   * can react), then push the message.
   *
   * An explicit synchronous assignment wakes through MasterAttention.
   *
   * Returns a structured result so the HTTP layer can distinguish "queued"
   * from "interaction pending — caller must opt-in to override".
   */
  sendUserMessage(
    message: string,
    options: { interject?: boolean; attachments?: CoderAttachment[]; boardAttachments?: import('@mcp/company-contracts').BoardAttachment[]; thinking?: boolean } = {},
  ): { ok: boolean; pending?: 'interactive_wait' } {
    const attachments = options.attachments;
    if (options.thinking !== undefined) {
      this._runtimeSnapshot = { ...this._runtimeSnapshot, thinking: options.thinking };
    }
    this._lastUserAttachments = attachments ?? [];
    this.deps.board.post('human', null, 'message', message, undefined, options.boardAttachments);
    this.notifyIdleUserMessage();

    if (!this._ended && !this.closingTurn && this._handle?.runner) {
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
      // Enrich with board context so the master gets the same situational
      // awareness it would get via `notify()`. Without this, a user message
      // sent while subordinates have been posting updates lands without
      // any of that context — master then asks redundant questions.
      // Attachments path skips enrichment (image/file blocks already carry
      // their own context); only the plain-text turn gets the prefix.
      if (attachments && attachments.length > 0) {
        runner.pushUserContent(attachmentsToBlocks(message, attachments));
      } else {
        runner.pushUserMessage(this.enrichWithBoard(message));
      }
      // Wake any explicit synchronous assignment after the message is queued.
      this.deps.attention.signal({
        kind: 'user_message',
        agentRunId: this._agentRunId,
        role: 'human',
      });
      return { ok: true };
    }
    // A start/resume is still provisioning the sandbox — the runner isn't
    // wired yet, so resurrect would bail (no handle) and drop the message.
    // Queue it; the background start/resume task flushes the queue once the
    // runner exists. Enrich the plain-text turn the same way the live branch
    // does; attachment turns carry their own context.
    if (this.coldResumeAck || this.resumingPromise || this.closingTurn) {
      this.resumeQueue.push({
        message: attachments && attachments.length > 0 ? message : this.enrichWithBoard(message),
        attachments,
      });
      return { ok: true };
    }
    if (this.resumeDormantAppMaster(message, attachments, options.thinking)) {
      return { ok: true };
    }
    // A live Company worker can outlive/precede its Master runner. App Studio
    // deliberately uses this state when rotating the Master conversation while
    // preserving specialist sessions. Cold-resume the newest persisted Master
    // instead of calling resurrect(), which requires an old handle.
    if (!this._handle) {
      void this.resumeExisting({
        userMessage: message,
        attachments,
        thinking: options.thinking,
      }).catch((error) => {
        const detail = error instanceof Error ? error.message : String(error);
        try { this.deps.board.post('system', null, 'blocker', `Master resume failed: ${detail}`); } catch { /* best-effort */ }
      });
      return { ok: true };
    }
    void Promise.all([
      this.deps.ctx.companyFiles.updateSessionStatus('running'),
      this.deps.ctx.companyFiles.clearRecoveryFlag(),
    ]).catch(() => undefined);
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
  /**
   * Narrow state-mutator interface the wiring helpers use to read/write
   * the master's private flags without becoming class methods. Returns
   * a fresh object per call — getters read live state from `this` via
   * a captured arrow closure.
   */
  private buildRunnerStateMutators(): MasterRunnerStateMutators {
    const self = this;
    return {
      setRunnerExited: (v) => { self._runnerExited = v; },
      setEnded: (v) => { self._ended = v; },
      setEndedWithError: (v) => { self._endedWithError = v; },
      setEndedAt: (v) => { self._endedAt = v; },
      notifyIdleEnded: () => self.notifyIdleEnded(),
    };
  }

  private wireAllForRunner(runner: CoderRunner, runId: string): void {
    wireMasterRunnerListeners(runner, runId, {
      wirer: this.deps.wirer,
      humanInLoop: this.deps.humanInLoop,
    });
    // The generic follow-up after a human answer is only for an acknowledgement
    // with no orchestration. A successful dispatch or decision already continued the work.
    runner.on('tool_call_result', (_id, name, result) => {
      if (this._shouldContinue && !result.isError && [
        'spawn_subordinate_agent', 'resume_subordinate', 'forward_to_agent',
        'answer_subordinate_question', 'approve_subordinate_plan', 'approve_subordinate_plans',
        'approve_subordinate_tasks', 'finalize_subordinates',
      ].includes(name)) {
        this._shouldContinue = false;
        this.deps.humanInLoop.consumeMasterShouldContinue();
      }
    });
    // docs_deep_research — DocsAgent escalation over the indexed doc corpus.
    // Per-runner install (not a static registry tool); the company-worker's
    // docsResearch RPC shim was already wired — this was the missing half.
    // Navigate-tier, so it surfaces via expand_toolset('navigate').
    installDocsDeepResearch(runner);
    this.maybeWireMasterSupervisor(runner, runId);
  }

  /**
   * Register the master with the AgentSupervisor + wire its runner heartbeats,
   * so the supervisor can finally observe the session's most important organ
   * (today `registerMaster` is otherwise test-only and the observation-layer
   * master handlers never fire). Covers both fresh start and resurrect because
   * `wireAllForRunner` is the single chokepoint for both.
   *
   * C2 — DEFAULT ON, gated by the per-session autonomy config (action
   * `supervisor`; kill-switches: `autonomy.supervisorMaster=false`, `freeze`,
   * or env `MCP_SUPERVISOR_MASTER='0'`). Flipping the default is safe TODAY
   * because the long event-driven waits now heartbeat the supervisor:
   * `tools/agent-wait-loop.ts` (`heartbeatAgentRunId`, fed by
   * `master-tools.ts` for synchronous assignments) and
   * `tools/subordinate/await-master.ts` (interval heartbeat) — so a healthy
   * ~30min wait no longer trips `STUCK_TOOL`. No-op when the supervisor
   * itself is disabled, so the gate stays a true superset.
   */
  private maybeWireMasterSupervisor(runner: CoderRunner, runId: string): void {
    const cfg = this.deps.autonomy
      ? this.deps.autonomy.get()
      : resolveAutonomy(null, process.env);
    if (!isAutonomyActionAllowed(cfg, 'supervisor')) return;
    const supervisor = getGlobalAgentSupervisor();
    if (!supervisor) return;
    supervisor.registerMaster({
      agentRunId: runId,
      companySessionId: this.deps.ctx.companySessionId,
    });
    const unsubscribe = wireSupervisorToRunner(runner, runId, 'master');
    // One-shot cleanup so listeners don't leak when this runner exits (a new
    // runner is created on resurrect). `done` also fires the TERMINAL
    // transition inside wireSupervisorToRunner.
    const emitter = runner as unknown as {
      once?: (event: string, listener: () => void) => void;
      on?: (event: string, listener: () => void) => void;
    };
    const onDone = (): void => { try { unsubscribe(); } catch { /* best-effort */ } };
    if (emitter.once) emitter.once('done', onDone);
    else emitter.on?.('done', onDone);
  }

  private attachCompletionHandler(handle: RunCoderHandle, runId: string): void {
    // onRunnerReady wired live events before a full RunCoderHandle existed.
    // Re-wiring is idempotent and attaches the transcriptFlushed terminal
    // boundary without duplicating any stream listeners.
    this.deps.wirer.wire(handle, 'master', runId);
    attachMasterCompletionHandler(handle, runId, {
      ctx: this.deps.ctx,
      board: this.deps.board,
      humanInLoop: this.deps.humanInLoop,
      state: this.buildRunnerStateMutators(),
      tryExplicitFallback: (detail) => this.continueWithExplicitFallback(detail),
    });
  }

  /**
   * Swap to the next explicit App Master fallback, persist provenance, then
   * re-open the same coder session/transcript. Generic Company returns false
   * from `applyExplicitMasterFallback` and keeps its legacy local behaviour.
   */
  private async continueWithExplicitFallback(errorDetail: string): Promise<boolean> {
    const runId = this._agentRunId;
    if (!runId) return false;
    const applied = await applyExplicitMasterFallback(
      runId,
      this._runtimeSnapshot.fallbackModels,
      errorDetail,
      { ctx: this.deps.ctx, board: this.deps.board },
    );
    if (!applied) return false;

    try {
      await this.resurrect(
        `[SYSTEM] The previous Master provider failed transiently (${errorDetail}). ` +
        `Continue the same task using the explicitly configured fallback ${applied.to.provider}/${applied.to.model}.`,
        undefined,
        this._runtimeSnapshot.thinking,
      );
      return !this._runnerExited && !!this._handle?.runner;
    } catch (error) {
      console.warn(
        `[company s=${this.deps.ctx.companySessionId}] Master fallback continuation failed:`,
        error,
      );
      return false;
    }
  }
}
