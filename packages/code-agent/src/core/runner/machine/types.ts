/**
 * Behavior Tree types — declarative states, events, nodes, and run context.
 *
 * The orchestrator iterates `state = nextState(state, await node.execute(ctx))`
 * until `Done`. Every transition is explicit in `transitions.ts` — no scattered
 * `continue`s, no implicit `break`s, no flag-driven side exits.
 *
 * Compared to the legacy `while (turn<maxTurns)` loop in runner.ts, the BT
 * makes the control flow:
 *   - testable in isolation (transitions.test.ts hits the table directly),
 *   - extensible without touching the loop body (new node = new file), and
 *   - debuggable from telemetry (every transition is a named event).
 */
import type { AgentMessage, ChatUsage } from '@mcp/code-agent/core/messages.js';
import type { ToolTier } from '@mcp/code-agent/tools/tiers.js';
import type { RunnerOptions, StopReason, TransitionKind } from '../types.js';
import type { RunnerEvents } from '../events.js';
import type { RecoveryKind } from '../recovery-config.js';
import type { AsyncOperationRegistry } from '../operations.js';
import type { NoProgressTracker } from '../guards/no-progress.js';

export type NodeState =
  | 'Bootstrap'
  | 'Executing'
  | 'Compacting'
  | 'Reviewing'
  | 'Recovering'
  | 'Done';

export type BehaviorEvent =
  | { kind: 'TurnSucceeded'; hasToolCalls: boolean }
  | {
      kind: 'TokenThresholdHit';
      ratio: number;
      /** A6 — which gate fired ('polling-loop' | 'stuck-progress' | 'cumulative'
       *  | 'token-budget' | 'body-after-prefix' | 'context-overflow'). */
      trigger?: string;
    }
  | { kind: 'MaxTurnsReached'; autoContinueLeft: number }
  | { kind: 'ProviderError'; retryable: boolean; status: number; message?: string; code?: string }
  | { kind: 'CompactionDone'; collapsedFrom: number; collapsedTo: number }
  | { kind: 'CleanFinish' }
  | { kind: 'Aborted' };

export type BehaviorEventKind = BehaviorEvent['kind'];


/**
 * Mutable state seen by every node. Replaces the dozens of private fields
 * scattered across the legacy `CodeAgentRunner` class.
 */
export interface RunContext {
  readonly opts: RunnerOptions;
  readonly emit: <E extends keyof RunnerEvents>(
    event: E,
    ...args: Parameters<RunnerEvents[E]>
  ) => void;
  messages: AgentMessage[];
  turn: number;
  totalUsage: ChatUsage;
  /**
   * Tier filter applied by `buildTools`. When non-null, always contains
   * `'bootstrap'` (invariant enforced by `ensureBootstrap`). When null,
   * tier filtering is disabled — every registered tool is exposed
   * (subagents/tests rely on this so MCP-external tools survive).
   */
  activeTiers: Set<ToolTier> | null;
  /**
   * Per-recovery-kind circuit breaker counters. Each kind has its own cap
   * resolved by `recoveryCap()`; the orchestrator aborts when a kind goes
   * over.
   */
  recovery: Map<RecoveryKind, number>;
  /** Provider-specific schema rejections affect projection, never authorization. */
  rejectedToolSchemas: Map<string, Set<string>>;
  lastProviderToolNames: ReadonlySet<string>;
  /** Consecutive 429/5xx retries for the current logical provider call. */
  transientRetriesThisTurn: number;
  transportRetriesThisTurn: number;
  /** Run-wide ordinal for physical upstream attempts persisted to telemetry. */
  providerAttempts: number;
  /** Cross-turn post-result observation + monotonic workspace state epoch. */
  noProgressTracker: NoProgressTracker;
  autoContinues: number;
  /**
   * Consecutive pre-emit compaction routings since the last turn that
   * actually issued a provider call. The pre-emit gate (`executing.ts`)
   * decrements `turn` when it fires, so `maxTurns` can't backstop a
   * compaction that keeps firing without ever freeing enough space. This
   * counter does: the Executing node aborts the run with
   * `stopReason='compact_exhausted'` once it exceeds
   * the fixed cap of 3. Reset to 0 whenever the gate
   * passes and the provider call proceeds.
   */
  preEmitCompactions: number;
  /**
   * Consecutive POST-TURN compaction passes that freed nothing (compactor
   * no-op'd: `collapsedFrom === 0`). The post-turn size gate (`executing.ts`)
   * is a pure function of prompt tokens with no state of its own, so a context
   * that can't shrink (e.g. a tool_result larger than the recede ceiling) would
   * otherwise re-trigger Compacting every turn — a no-op loop (confirmed in
   * telemetry: one run churned 94 consecutive no-ops). After
   * 2 such passes (fixed cap) the size gate is suppressed —
   * NOT aborted (unlike pre-emit); the model keeps progressing. Incremented in
   * CompactingNode on a no-op, reset on a real compaction or when the gate goes
   * quiet (prompt fell back below the trigger).
   */
  consecutiveNoopCompactions: number;
  /**
   * Mandatory-plan nudges issued this run. In plan mode, a text-only turn that
   * ends without ever submitting a plan (and without approval) gets ONE
   * `<system-reminder>` nudge to call `submit_plan`/`task_list` before the
   * Executing node lets the run finish. Bounded at 1 so a genuinely
   * conversational reply (greeting / trivial Q&A) still terminates after the
   * nudge instead of looping. Incremented by the Executing node's plan gate.
   */
  planNudges: number;
  /**
   * Completion-evidence observation state. The ledger boundary scopes
   * advisory health classification to this run.
   */
  verification: {
    ledgerStartSeq: number;
    nudges: number;
  };
  /**
   * Perf W1 — background compaction-summary precompute. Kicked by the
   * Executing post-turn gate when the size ratio nears the trigger, consumed
   * (and cleared) by the Compacting node so the ~2-minute inline summary
   * stall happens off the critical path. Null = nothing in flight. See
   * `compaction/precompute.ts` for the identity-validation contract.
   */
  summaryPrecompute: import('../compaction/precompute.js').SummaryPrecomputeState | null;
  /**
   * Perf W1 — memoized `buildTools` output. The catalog is a pure function
   * of (tiers, pins, cap, terse lock, model) which are constant for long
   * stretches of a run, yet it was rebuilt — registry scan, tool-filter hook
   * fs read, sort, terse mapping and a full catalog JSON.stringify — on
   * EVERY turn. Keyed by `buildToolsCacheKey` plus the run-constant inputs;
   * invalidated automatically when the key changes (new pin / tier
   * promotion). `variants` caches the serialized JSON + fingerprint for the
   * telemetry path (full vs `get_tool_output`-trimmed membership).
   */
  toolsMemo: {
    key: string;
    built: import('../assembly/tools.js').BuildToolsResult;
    variants: Map<string, {
      tools: import('../assembly/tools.js').SerializedTool[];
      json: string | null;
      fingerprint: string | null;
      capabilitySetDigest: string | null;
      projectionDigest: string | null;
    }>;
  } | null;
  /**
   * EMA of `real_prompt_tokens / tokenizer_estimate`, learned on turns where
   * the provider reported usage. Calibrates the pre-emit projection and the
   * estimate fallback of the post-turn gates (chars/4 drifts with content
   * mix). `null` until the first usage-bearing turn (treated as 1).
   */
  estimateCalibration: number | null;
  /** Stable run id (uuid) for telemetry correlation. */
  runId: string;
  aborted: boolean;
  /** Recovery path that led to termination (RunResult.transition). */
  transition: TransitionKind | null;
  /** Final stop reason — set by a node BEFORE emitting CleanFinish/Aborted. */
  stopReason: StopReason | null;
  /** Underlying error for failure modes. */
  error: Error | null;
  /** Live registry for long async operations that must emit terminal events. */
  operations: AsyncOperationRegistry;
  /**
   * Optional bridge to features still owned by the legacy `CoderRunner`.
   * When unset the BT uses safe defaults (no skills, no plan-mode gate, etc.).
   */
  bridge?: BridgeCallbacks;
  /**
   * Telemetry — UUID of the most recent immutable turn metric this
   * run inserted, or null when persistence is unavailable / hasn't yet
   * fired this run. `ExecutingNode` updates this AFTER each successful
   * turn so the host's `flushPendingTurn` (in `index.ts`) can stamp the
   * pending tool calls with the same artifact reference.
   */
  lastTurnTelemetryId: string | null;
  /**
   * PR 5 — per-tool consecutive-failure counters. Closes the gap that
   * let 13 `write_stdin` failures escape every other guard in session
   * 798 by treating `isError=true` as the SOLE loop signal.
   *
   * Lifecycle: empty on Bootstrap, accumulated by Executing's dispatch
   * (`executing-dispatch.ts`) on every tool result. A single
   * `isError=false` clears the entry for that tool; thresholds trigger
   * reminder / refuse verdicts. State survives across turns within a
   * run; fresh run starts empty.
   */
  failureStreaks: import('../guards/failure-streak.js').FailureStreakState;
  /**
   * P0 — dominance rolling window (last N tool-turns + whether each carried
   * assistant text). Catches one tool grinding a long window with ZERO text
   * (the silent 200–700-turn runaways) that the doom-loop's near-consecutive
   * window misses when other tools intersperse. Reset when it FIRES.
   */
  dominance: import('../guards/dominance.js').DominanceState;
  /**
   * Loop-aware compaction signals (Fix B). Fed every Executing turn and
   * consumed by `evaluateLoopAwareCompaction` so compaction fires on
   * behavioral loops / steady burn — not just the per-turn ratio gate, which
   * never tripped for wide-window models (gpt-5.5 = 272k) nor for providers
   * that omit `usage` (the ChatGPT backend).
   *
   *   - `consecutiveNoTextTurns`     — turns in a row with zero assistant
   *     text; drives the `stuck-progress` branch. Reset on any text turn and
   *     on a successful compaction.
   *   - `cumulativeInputTokens`      — best-effort sum of each turn's prompt
   *     size (real `usage.input_tokens` when present, else the tokenizer
   *     estimate). DISTINCT from `totalUsage` (real-usage-only, for cost):
   *     this one always advances so the `cumulative` branch works without
   *     provider usage. Drives the `cumulative` branch.
   *   - `cumulativeAtLastCompaction` — checkpoint subtracted from the above
   *     so the monotonic cumulative branch can't re-fire every turn after a
   *     compaction.
   */
  consecutiveNoTextTurns: number;
  cumulativeInputTokens: number;
  cumulativeAtLastCompaction: number;
  /**
   * PR-F dynamic-injection state. Tracked across turns so the Kimi-style
   * `computeDynamicInjection` provider doesn't include the same skill /
   * file twice across consecutive turns.
   *
   *   - `lastInjectedSkillIds` — skill ids already mentioned in a
   *     prior turn's `<system-reminder>`.
   *   - `lastInjectedFiles`    — file paths already mentioned.
   *   - `recentCompactionAt`   — turn index at which the Compacting node
   *     last fired; the injector emits a "context summarized" notice for
   *     the next ≤2 turns so the model knows older detail was dropped.
   *
   * Mutated by Executing (after a successful injection) and Compacting
   * (on every successful collapse). Empty by default.
   */
  injectionState: {
    lastInjectedSkillIds: Set<string>;
    /**
     * B1/G3 — skill ids whose bodies have been surfaced in `<active_skills>` in
     * an EARLIER turn this run (NOT reset like `lastInjectedSkillIds`, which is
     * per-turn dedup). After a compaction the injector reminds the model that a
     * still-active skill seen before was already used — so it doesn't re-run the
     * skill's one-time setup whose evidence the summary dropped. Updated after
     * each assembly with that turn's active skills; in-memory (per run).
     */
    executedSkillIds: Set<string>;
    lastInjectedFiles: Set<string>;
    recentCompactionAt: number | null;
    /** Memory ids already injected (Mem C) — avoids re-injecting each turn. */
    lastInjectedMemoryIds: Set<string>;
    /** Hash of the last injected Session State Block — re-inject on change. */
    lastInjectedSessionStateHash: string | null;
    /** Hash of the last injected project memory index — re-inject on change. */
    lastInjectedProjectIndexHash: string | null;
    /** Hash of the last injected conversation chapter index. */
    lastInjectedConversationChapterIndexHash: string | null;
    /** Hash of the last injected user-preferences block — re-inject on change. */
    lastInjectedUserMemoryHash: string | null;
    /** Hash of the last injected `<preflight>` hint — re-inject on milestones only. */
    lastInjectedPreflightHash: string | null;
    /**
     * Project memory retrieved THIS turn (async, before assembly) so the
     * synchronous dynamic injector can include it. Reset each turn.
     */
    pendingMemory?: ReadonlyArray<{ id: string; title: string; content: string; staleNote?: string }>;
    /** At most two 400-char excerpts from older chapters for the new task. */
    pendingConversationChapters?: ReadonlyArray<{ id: string; title: string; content: string }>;
    /** Throttle key for proactive recall: the STABLE pre-synthesis task text
     *  (raw message, or the walk-back for a meta/continuation message) — NOT
     *  the LLM-synthesized query, which is non-deterministic and would defeat
     *  the throttle. */
    lastMemoryQuery?: string;
    lastConversationChapterQuery?: string;
    lastInjectedConversationChapterIds: Set<string>;
    /**
     * Correction-nudge throttle (assembly/correction-nudge.ts): at most once
     * per distinct user message (hash) and `count` ≤ 3 per RUN. RunContext
     * (and this state) is rebuilt per run — i.e. per user message in the
     * normal chat cadence — so across a session the effective bound is "once
     * per correction-looking message", which is the desired trigger anyway;
     * the cap guards steering-heavy multi-turn runs (queued messages).
     */
    correctionNudge: { lastHash: string | null; count: number };
  };
}

export interface BehaviorNode {
  readonly state: NodeState;
  /**
   * @param ctx       mutable run context shared across the whole run
   * @param lastEvent event that caused the transition INTO this node, or
   *                  `null` for the initial Bootstrap invocation. Nodes
   *                  consult this when they need the originating signal
   *                  (e.g. Recovering inspects the `ProviderError` status).
   */
  execute(ctx: RunContext, lastEvent: BehaviorEvent | null): Promise<BehaviorEvent>;
}

/**
 * Bridge callbacks injected by the legacy `CoderRunner` into the BT so the
 * Executing node can delegate features it doesn't reimplement (skills,
 * active-context, plan-mode gate, …) back to methods
 * that already exist on the runner. Keeps the BT slim while preserving
 * production behavior.
 *
 * Every field is optional — a node that doesn't see a callback falls
 * through to its default (e.g. no skills block, allow all tool calls).
 */
export interface BridgeCallbacks {
  /**
   * Terminal abort requested by the host runner. The behavior-tree runtime
   * owns its own RunContext, so it must explicitly consult this bridge at
   * node boundaries; otherwise `CoderRunner.abort()` only releases pending
   * interactive waits and the tree keeps issuing provider/tool turns.
   */
  isAbortRequested?: () => boolean;
  /** Pending semantic lifecycle milestone awaiting the next real size compaction. */
  peekMilestoneCompaction?: () => string | null;
  /** Clear the milestone only after Executing actually emits its trigger. */
  clearMilestoneCompaction?: () => void;
  /** Build the `<active_skills>` block from the trailing user message. */
  buildActiveSkillsBlock?: (compactedHistory: AgentMessage[]) => string | null;
  /** Build the `<active-context>` block (todos + scope). */
  buildActiveContextBlock?: () => string | null;
  /**
   * Resolve the temperature for this turn. Returns null when the model
   * rejects sampling (e.g. OpenAI o-series with reasoning).
   */
  resolveTemperature?: () => { temperature: number; source: string } | null;
  /** Read the current Responses-API state (Codex/ChatGPT only). */
  getPreviousResponseId?: () => { id: string; messageCount: number } | null;
  /** Callback fired when the provider returns a new response.id. */
  onResponseId?: (id: string, messageCount: number) => void;
  /**
   * Pre-dispatch tool gate — returns a refuse string when the call should
   * be blocked (plan/spec mode + mutating tool, sandbox required, …),
   * null when allowed.
   */
  toolGate?: (toolName: string, input: unknown) => string | null;
  /**
   * Whether the user has approved a plan in this run (`runner.isPlanApproved()`).
   * Read by the Executing node's mandatory-plan gate so a plan-mode run can't
   * end with a text-only "switch to build" without ever submitting a plan.
   */
  isPlanApproved?: () => boolean;
  /**
   * Pre-read enforcement — refuse re-reads of the same path+slice that
   * a prior turn already produced. Returns a refusal string when the
   * call should be blocked, null when allowed.
   */
  enforcePreRead?: (
    toolName: string,
    input: unknown,
    turn: number,
    toolUseId: string,
  ) => string | { content: string; isError?: boolean } | null;
  /**
   * Task-mode gate — when the user approved a task list with
   * `execution_mode='all-subagent'`, refuse mutating tool calls that
   * would bypass `execute_task`. Returns refusal text or null.
   */
  enforceTaskMode?: (toolName: string, toolMutates: boolean) => string | null;
  /**
   * Supervisor recovery (Phase 2.3) — lets an external watcher unwedge a
   * single stuck tool call WITHOUT terminating the run. The runner tracks
   * each non-interactive invocation's AbortController by tool_use_id; the
   * supervisor's `injectToolResultError(toolUseId, msg)` aborts the matching
   * one and stashes `msg`, which dispatch surfaces as the tool_result so the
   * loop continues. No-ops when absent (subagents / tests).
   */
  registerInFlightTool?: (toolUseId: string, ctl: AbortController) => void;
  unregisterInFlightTool?: (toolUseId: string) => void;
  /** Read-and-clear a supervisor-injected error message for an aborted call. */
  consumeInjectedToolError?: (toolUseId: string) => string | undefined;
  /**
   * Smart-reducer post-result hook. Receives the raw tool result content
   * and returns a possibly-shortened version (tool-aware truncation, e.g.
   * git_log keeps the head commits, grep keeps the first matches).
   */
  reduceToolResult?: (
    toolName: string,
    content: string,
    meta?: {
      input: Record<string, unknown>;
      isError: boolean;
      contentFormat: 'text' | 'markdown' | 'json';
    },
  ) => string | import('@mcp/code-agent/core/smart-reducers.js').DetailedReduction;
  /**
   * Live final shaping hook. Spills the raw original to the side-file store
   * and applies the generic fail-safe cap with an output_id marker. Returns
   * the content to push plus the `truncated` flag (so resume won't re-cut).
   */
  finalizeToolResult?: (args: {
    toolName: string;
    rawContent: string;
    shapedContent: string;
    isError: boolean;
    reductionReport?: import('@mcp/code-agent/core/smart-reducers.js').ReductionReport;
    sourceTruncations?: import('@mcp/code-agent/core/tool.js').ToolSourceTruncation[];
  }) => {
    content: string;
    truncated?: boolean;
    originalSize?: number;
    outputId?: string;
    inlineCap?: number;
    reductionReport?: import('@mcp/code-agent/core/smart-reducers.js').ReductionReport;
  };
  /**
   * Post-result hook for runner-owned state that needs raw and shaped
   * content (mutation-aware reread diffs, write tracking, etc.).
   */
  postProcessToolResult?: (args: {
    toolUseId: string;
    name: string;
    input: Record<string, unknown>;
    rawContent: string;
    content: string;
    isError: boolean;
    turn: number;
  }) => { content: string; isError?: boolean } | null | void;
  /**
   * Polling-stuck detector. Tracks consecutive identical results for
   * polling tools (`repeatable=true`). Returns a refusal string when
   * the polling has been stuck N times in a row, null otherwise.
   */
  detectPollingStuck?: (
    toolName: string,
    content: string,
    isError: boolean,
    isRepeatable: boolean,
    turn: number,
  ) => string | null;
  /**
   * Await the host's previous-turn durability boundary before this turn may
   * call the provider. The host schedules its flush from the synchronous
   * `turn_start` event immediately before this callback is awaited.
   */
  awaitTurnPersistence?: () => Promise<void>;
  /**
   * PR-F — supply per-turn signals that drive Kimi-style dynamic
   * injection. Returns the diff between the runner's current view of
   * skills/files and what's been seen so far this turn:
   *
   *   - `newlyRegisteredSkillIds` — skills the host registered THIS
   *     session that the reminder hasn't surfaced yet.
   *   - `recentlyEditedFiles`     — paths the agent's tools touched in
   *     the last N turns.
   *
   * Returns null when there's nothing fresh; that short-circuits the
   * provider so most turns have no reminder.
   */
  collectDynamicInjectionSignals?: () => {
    newlyRegisteredSkillIds: ReadonlyArray<string>;
    recentlyEditedFiles: ReadonlyArray<string>;
  } | null;
  /**
   * Async retrieval of relevant project memory for the current task (Mem C).
   * The Executing node awaits this BEFORE assembling messages (the dynamic
   * injector is synchronous) and stashes the result in `injectionState`.
   * Returns items already relevance-gated + ranked by the host. Unset =
   * memory injection disabled.
   */
  getRelevantProjectMemory?: (
    taskText: string,
    turn: number,
  ) => Promise<ReadonlyArray<{ id: string; title: string; content: string; staleNote?: string }>>;
  onMemoryInjected?: (ids: readonly string[]) => void | Promise<void>;
  /**
   * Mem C — optional LLM query synthesizer for meta/continuation messages.
   * The Executing node calls it (fail-open) BEFORE `getRelevantProjectMemory`
   * to turn a task-less message into a real search query; null → the node uses
   * its walk-back heuristic. Unset = heuristic only.
   */
  synthesizeMemoryQuery?: (
    tail: ReadonlyArray<{ role: 'user' | 'assistant'; text: string }>,
  ) => Promise<string | null>;
  /**
   * Session State Block data (replaces the old per-field Session Drive
   * injection) — synchronous read of the session's persisted state: goal,
   * active plan, todos, notes, changed files, investigation count. The
   * Executing node renders it (`assembly/session-state.ts`) and injects per
   * the window-scaled policy (`assembly/injection-policy.ts`). Unset = off.
   */
  getSessionStateData?: () => {
    activePlan: { text: string; status: string } | null;
    todos: ReadonlyArray<{ status: string; label: string }>;
    notes: ReadonlyArray<{ id: string; title: string; body: string; kind: string; pinned: boolean }>;
    filesChanged: ReadonlyArray<string>;
    investigationCount: number;
  } | null;
  /**
   * Project memory index (MEMORY.md-style) — top-N titles of the project's
   * durable memory, injected at turn 1 / post-compaction so every session
   * knows what the project already learned. Unset = off.
   */
  getProjectMemoryIndex?: () => ReadonlyArray<{ title: string; category: string }> | null;
  /**
   * Session-scoped conversation chapter index. Only recent titles are injected;
   * full summaries/source remain available through recall_conversation.
   */
  getConversationChapterIndex?: () => Promise<{
    total: number;
    entries: ReadonlyArray<{ id: string; ordinal: number; title: string; source?: string }>;
  } | null>;
  getRelevantConversationChapters?: (
    taskText: string,
    turn: number,
  ) => Promise<ReadonlyArray<{ id: string; title: string; content: string }>>;
  /**
   * Global user-preferences index (migration 145) — top-N user/feedback
   * memories (title + excerpt) injected into EVERY project. NOT gated by the
   * project's memory toggle. Unset = off.
   */
  getUserMemoryIndex?: () => ReadonlyArray<{ title: string; category?: string; excerpt?: string }> | null;
  /**
   * Drain `runner.pendingUserMessages` into the main `messages` array.
   * Called at the START of each Executing turn so messages pushed via
   * `runner.pushUserMessage` (master → subordinate, SSE push from the
   * dashboard) land BEFORE the model is invoked — instead of being
   * silently held forever on the runner.
   *
   * Implemented in `runner.ts:runViaBehaviorTree`; no-op when unset.
   */
  flushPendingMessages?: () => void;
  /**
   * True when `pushUserMessage` accepted a message that has not reached the
   * live history yet. The orchestrator checks this synchronously before
   * committing a `CleanFinish` transition to `Done`; if work is pending it
   * re-enters `Executing`, whose first action is `flushPendingMessages`.
   *
   * Keeping the check beside the terminal transition closes the last-turn
   * race: a message injected while the provider/tool turn is in flight must
   * either produce another turn or arrive after the runner emitted `done`
   * (when the HTTP layer falls back to a fresh run).
   */
  hasPendingMessages?: () => boolean;
  /**
   * Per-turn telemetry persistence — wraps the pure
   * `core/runner/telemetry/persist-turn.ts` helper. Returns the written turn metric UUID so the
   * Executing node can update `ctx.lastTurnTelemetryId` for the host's
   * `flushPendingTurn` to consume.
   *
   * Unset on subagents / standalone tests — the BT then skips
   * persistence entirely (no-op, no row, no error).
   */
  persistTurnTelemetry?: (input: {
    turn: number;
    /** Auto-continue batches consumed by this run at the time of the turn. */
    autoContinues: number;
    usage: import('@mcp/code-agent/core/messages.js').ChatUsage | null;
    toolUseBlocks: ReadonlyArray<import('@mcp/code-agent/core/messages.js').ToolUseBlock>;
    toolResultBlocks: ReadonlyArray<import('@mcp/code-agent/core/messages.js').ContentBlock>;
    historyChars: number;
    systemPromptChars: number;
    toolsDefChars: number;
    eligibleToolsDefChars?: number;
    visibleToolsCount?: number;
    /** Prompt-cache diagnostics (mig 143) — see telemetry/prefix-head.ts. */
    toolsFingerprint?: string | null;
    capabilitySetDigest?: string | null;
    projectionDigest?: string | null;
    prefixHeadHash?: string | null;
    reducerStats?: { retired: number; freedChars: number; pendingRetired: number; pendingChars: number } | null;
    responseMeta: import('@mcp/code-agent/core/messages.js').ChatProviderResponseMeta | null;
    compactionTriggered: boolean;
    summarizerRan: boolean;
    // The filesystem metric UUID lands on ctx.lastTurnTelemetryId when the
    // per-session writer settles.
  }) => string | null | Promise<string | null>;
  /**
   * Background (fire-and-forget) subagent liveness. Present only when the
   * host wired the job manager (single sessions with subagent capability);
   * undefined for subagents, company masters, and tests. When set, the
   * orchestrator does NOT end a clean run while `hasActive()` is true — it
   * `park()`s until a job settles (→ 'work', notice already injected), the
   * user sends a message ('message'), the run aborts ('aborted'), or a
   * safety cap elapses ('timeout').
   */
  backgroundJobs?: {
    hasActive: () => boolean;
    park: (signal: AbortSignal) => Promise<'work' | 'message' | 'aborted' | 'timeout'>;
  };
}

/** Transition table shape: `TRANSITIONS[state][event.kind] = nextState`. */
export type TransitionTable = Readonly<
  Record<NodeState, Partial<Record<BehaviorEventKind, NodeState>>>
>;
