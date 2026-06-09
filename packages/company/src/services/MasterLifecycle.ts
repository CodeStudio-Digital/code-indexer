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
import type { CompanyEventBus } from '@mcp/company/services/CompanyEventBus.js';
import { parseMasterConfigFromDb } from '@mcp/company/services/master/config-loader.js';
import { enrichMessageWithBoard } from '@mcp/company/services/master/board-enrichment.js';
import {
  attachMasterCompletionHandler,
  wireMasterRunnerListeners,
  type MasterRunnerStateMutators,
} from '@mcp/company/services/master/runner-wiring.js';
import {
  startMaster,
  type MasterStartOpts,
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
  /**
   * Phase E: enable extended thinking ("deep reasoning") for subordinates
   * spawned with this role. Forwarded into `runCoder({ thinking })` →
   * `runner.opts.thinking`, which each provider adapter translates into
   * the appropriate API parameter (Anthropic `thinking.type=enabled`,
   * Gemini `reasoning`, etc.). Providers that don't support it ignore
   * the flag silently.
   *
   * `thinkingBudgetTokens` only matters for Anthropic — passed to the
   * SDK as `thinking.budget_tokens`. Defaults to provider-determined
   * (usually 5000) when undefined.
   *
   * Both fields are optional; absence is identical to legacy behaviour.
   */
  thinking?: boolean;
  thinkingBudgetTokens?: number;
  /**
   * Phase F: simulated deepThink. Orthogonal to `thinking` — both can be on.
   * Subordinates spawned with this role get an auxiliary (cheap) model call
   * before each main-model turn; its output is prefilled as a pre-thought.
   * Forwarded into `runCoder({ deepThink, deepThinkModel, deepThinkProvider,
   * preThinkOnToolResults })`. All four are optional; absence is identical
   * to legacy behaviour. See packages/code-agent/RunnerOptions for full
   * field docs.
   */
  deepThink?: boolean;
  deepThinkModel?: string;
  deepThinkProvider?: string;
  preThinkOnToolResults?: boolean;
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
  /** ISO timestamp of when the runner most recently exited. */
  get endedAt(): string | null { return this._endedAt; }
  /** ISO timestamp of when a user message most recently arrived. */
  get lastUserMessageAt(): string | null { return this._lastUserMessageAt; }

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

  getRoleDefaults(role: string): { provider?: string; model?: string; tier?: string; skills?: RoleSkills; systemPromptOverride?: string; projectIds?: number[]; temperature?: number; thinking?: boolean; thinkingBudgetTokens?: number; deepThink?: boolean; deepThinkModel?: string; deepThinkProvider?: string; preThinkOnToolResults?: boolean } | null {
    const cfg = this._roleConfigs.find((r) => r.role === role);
    return cfg ? {
      provider: cfg.provider,
      model: cfg.model,
      tier: cfg.tier,
      skills: cfg.skills,
      systemPromptOverride: cfg.systemPromptOverride,
      projectIds: cfg.projectIds,
      temperature: cfg.temperature,
      thinking: cfg.thinking,
      thinkingBudgetTokens: cfg.thinkingBudgetTokens,
      deepThink: cfg.deepThink,
      deepThinkModel: cfg.deepThinkModel,
      deepThinkProvider: cfg.deepThinkProvider,
      preThinkOnToolResults: cfg.preThinkOnToolResults,
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
    const row = ctx.companyStore.getCompanySession(ctx.companySessionId);
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
      // Wake a master parked in `wait_for_subordinates`. That tool is an
      // event loop on MasterAttention, NOT a `waitForUserInput`, so the
      // `interruptWait` above can't break it and `pushUserMessage` alone
      // leaves the message stranded until the next signal happens to land
      // while the wait loop is subscribed. Emit AFTER the push (the message
      // must already be queued when the wait wakes). Mirrors what
      // `sendUserMessage` does for `user_message`, but covers EVERY notify
      // path — plan/question/tasks (which also emit their own kind) AND the
      // inbox / auto-continue paths that previously emitted nothing.
      this.deps.attention.signal({
        kind: 'notify',
        agentRunId: this._agentRunId ?? 0,
        role: 'system',
      });
      return;
    }
    this.notifyIdleResurrected();
    void this.resurrect(enriched);
  }

  /** Phase 8 part 3: prefer the bus; fall back to direct ref for tests. */
  private notifyIdleResurrected(): void {
    if (this.deps.eventBus) this.deps.eventBus.emit({ type: 'master.resurrected' });
    else this.deps.idle?.onMasterResurrected();
  }
  private notifyIdleEnded(): void {
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
    return startMaster(opts, {
      ctx: this.deps.ctx,
      board: this.deps.board,
      orchestratorRef: this.deps.orchestratorRef,
      state: this.buildStartStateMutators(),
      wireRunner: (runner, runId) => this.wireAllForRunner(runner, runId),
      attachCompletion: (handle, runId) => this.attachCompletionHandler(handle, runId),
    });
  }

  /** Build the state-mutator surface shared by start + resume. */
  private buildStartStateMutators(): MasterStartStateMutators {
    const self = this;
    return {
      get hasHandle() { return !!self._handle; },
      get roleConfigs() { return self._roleConfigs; },
      get allowedModels() { return self._allowedModels; },
      setAgentRunId: (id) => { self._agentRunId = id; },
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

  async resumeExisting(opts: MasterResumeOpts): Promise<MasterStartResult> {
    return resumeMaster(opts, {
      ctx: this.deps.ctx,
      board: this.deps.board,
      orchestratorRef: this.deps.orchestratorRef,
      state: this.buildStartStateMutators(),
      wireRunner: (runner, runId) => this.wireAllForRunner(runner, runId),
      attachCompletion: (handle, runId) => this.attachCompletionHandler(handle, runId),
    });
  }

  // ─── Resurrection (subordinate finished after master exited) ───

  private async resurrect(
    message: string,
    attachments?: CoderAttachment[],
    thinking?: boolean,
  ): Promise<void> {
    return resurrectMaster(message, attachments, thinking, {
      ctx: this.deps.ctx,
      status: this.deps.status,
      board: this.deps.board,
      state: this.buildResurrectStateMutators(),
      wireRunner: (runner, runId) => this.wireAllForRunner(runner, runId),
      attachCompletion: (handle, runId) => this.attachCompletionHandler(handle, runId),
    });
  }

  /** Build the state-mutator surface used by the resurrect helper. */
  private buildResurrectStateMutators(): MasterResurrectStateMutators {
    const self = this;
    return {
      get handle() { return self._handle; },
      get companyContext() { return self._companyContext; },
      get promptBlock() { return self._promptBlock; },
      get agentRunId() { return self._agentRunId; },
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
   * `wait_for_subordinates` is NOT a `waitForUserInput` wait — it's an
   * event loop on `MasterAttention`, so `isWaitingForInput()` is false and
   * `interruptWait()` can't break it. Instead, after pushing the message we
   * fire a `user_message` attention signal (below) which the wait loop
   * listens for and returns from, so the master reads the message without
   * waiting for a subordinate to finish.
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
    this.notifyIdleUserMessage();

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
      // Wake `wait_for_subordinates` if the master is parked there. The
      // message is already in pendingUserMessages (pushed above); this signal
      // makes the wait loop return so the master runs a turn and reads it now
      // instead of after a subordinate finishes. No-op when no wait loop is
      // subscribed (master mid-turn / blocked in ask_user) — signal() iterates
      // an empty listener set.
      this.deps.attention.signal({
        kind: 'user_message',
        agentRunId: this._agentRunId ?? 0,
        role: 'human',
      });
      return { ok: true };
    }
    // A start/resume is still provisioning the sandbox — the runner isn't
    // wired yet, so resurrect would bail (no handle) and drop the message.
    // Queue it; the background start/resume task flushes the queue once the
    // runner exists. Enrich the plain-text turn the same way the live branch
    // does; attachment turns carry their own context.
    if (this.resumingPromise) {
      this.resumeQueue.push({
        message: attachments && attachments.length > 0 ? message : this.enrichWithBoard(message),
        attachments,
      });
      return { ok: true };
    }
    try {
      this.deps.ctx.companyStore.updateCompanySessionStatus(
        this.deps.ctx.companySessionId,
        'running',
      );
      // P15c — fresh user message resurrects the master; clear the
      // "Recovered after restart" pill so the dashboard hides it.
      this.deps.ctx.companyStore.clearSessionRecoveryFlag(
        this.deps.ctx.companySessionId,
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
  /**
   * Narrow state-mutator interface the wiring helpers use to read/write
   * the master's private flags without becoming class methods. Returns
   * a fresh object per call — getters read live state from `this` via
   * a captured arrow closure.
   */
  private buildRunnerStateMutators(): MasterRunnerStateMutators {
    const self = this;
    return {
      get attentionOff() { return self._attentionOff; },
      setAttentionOff: (off) => { self._attentionOff = off; },
      setRunnerExited: (v) => { self._runnerExited = v; },
      setEnded: (v) => { self._ended = v; },
      setEndedWithError: (v) => { self._endedWithError = v; },
      setEndedAt: (v) => { self._endedAt = v; },
      get isEnded() { return self._ended; },
      get isRunnerExited() { return self._runnerExited; },
      notifyIdleEnded: () => self.notifyIdleEnded(),
    };
  }

  private wireAllForRunner(runner: CoderRunner, runId: number): void {
    wireMasterRunnerListeners(runner, runId, {
      wirer: this.deps.wirer,
      humanInLoop: this.deps.humanInLoop,
      attention: this.deps.attention,
      state: this.buildRunnerStateMutators(),
    });
  }

  private attachCompletionHandler(handle: RunCoderHandle, runId: number): void {
    attachMasterCompletionHandler(handle, runId, {
      ctx: this.deps.ctx,
      board: this.deps.board,
      humanInLoop: this.deps.humanInLoop,
      state: this.buildRunnerStateMutators(),
    });
  }
}
