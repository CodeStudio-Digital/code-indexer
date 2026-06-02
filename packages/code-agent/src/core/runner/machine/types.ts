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

export type NodeState =
  | 'Bootstrap'
  | 'Planning'
  | 'Executing'
  | 'Compacting'
  | 'Reviewing'
  | 'Recovering'
  | 'Done';

export type BehaviorEvent =
  | { kind: 'TurnSucceeded'; hasToolCalls: boolean }
  | { kind: 'TokenThresholdHit'; ratio: number }
  | { kind: 'ToolLoopDetected'; guard: 'tuple-hash' | 'doom-loop' | 'dominance' | 'failure-streak' }
  | { kind: 'MaxTurnsReached'; autoContinueLeft: number }
  | { kind: 'ProviderError'; retryable: boolean; status: number }
  | { kind: 'CompactionDone'; collapsedFrom: number; collapsedTo: number }
  | { kind: 'CleanFinish' }
  | { kind: 'Aborted' };

export type BehaviorEventKind = BehaviorEvent['kind'];

/** Entry in the tuple-hash dedup table (Kimi-style anti-loop). */
export interface DupCallEntry {
  count: number;
  firstTurn: number;
  lastUseId: string;
}

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
  /** Tuple-hash dedup table. Key = `${name}|${stableArgsKey(input)}`. */
  dupCalls: Map<string, DupCallEntry>;
  /**
   * Cross-cycle loop-refusal counter. Key = same as `dupCalls`
   * (`${name}|${stableArgsKey(input)}`), value = how many times this exact
   * call has been HARD-refused by the tuple-hash guard across the whole run.
   *
   * Unlike `dupCalls`, this is NEVER cleared by `resetDupCalls` (the Planning
   * reset). That's the point: it remembers that a refused call keeps coming
   * back after each clean slate, so the Executing node can escalate from a
   * passive text refusal to an ACTIVE enforcement <system-reminder> (tool
   * list + "break out of the loop"). Without this, an insistent loop
   * (refuse → planning resets → retry → refuse → …) never escalates.
   */
  loopRefusals: Map<string, number>;
  autoContinues: number;
  /**
   * Consecutive pre-emit compaction routings since the last turn that
   * actually issued a provider call. The pre-emit gate (`executing.ts`)
   * decrements `turn` when it fires, so `maxTurns` can't backstop a
   * compaction that keeps firing without ever freeing enough space. This
   * counter does: the Executing node aborts the run with
   * `stopReason='compact_exhausted'` once it exceeds
   * `CODER_PREEMIT_COMPACT_MAX` (default 3). Reset to 0 whenever the gate
   * passes and the provider call proceeds.
   */
  preEmitCompactions: number;
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
   * When unset the BT uses safe defaults (no skills, no quality suffix,
   * no plan-mode gate, etc.).
   */
  bridge?: BridgeCallbacks;
  /**
   * Telemetry — id of the most recent `coder_turn_telemetry` row this
   * run inserted, or null when persistence is unavailable / hasn't yet
   * fired this run. `ExecutingNode` updates this AFTER each successful
   * turn so the host's `flushPendingTurn` (in `index.ts`) can stamp the
   * pending tool calls with the same id (FK across `tool_calls` ↔
   * `coder_turn_telemetry`).
   */
  lastTurnTelemetryId: number | null;
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
    lastInjectedFiles: Set<string>;
    recentCompactionAt: number | null;
    /** Memory ids already injected (Mem C) — avoids re-injecting each turn. */
    lastInjectedMemoryIds: Set<string>;
    /**
     * Project memory retrieved THIS turn (async, before assembly) so the
     * synchronous dynamic injector can include it. Reset each turn.
     */
    pendingMemory?: ReadonlyArray<{ id: string; title: string; content: string }>;
    /** Task text the pending memory was retrieved for (throttle key). */
    lastMemoryQuery?: string;
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
 * active-context, quality feedback, plan-mode gate, …) back to methods
 * that already exist on the runner. Keeps the BT slim while preserving
 * production behavior.
 *
 * Every field is optional — a node that doesn't see a callback falls
 * through to its default (e.g. no skills block, allow all tool calls).
 */
export interface BridgeCallbacks {
  /** Build the `<active_skills>` block from the trailing user message. */
  buildActiveSkillsBlock?: (compactedHistory: AgentMessage[]) => string | null;
  /** Build the `<active-context>` block (goal + todos + scope). */
  buildActiveContextBlock?: () => string | null;
  /** Build the quality-feedback suffix appended to the system prompt. */
  buildQualityFeedbackSuffix?: () => string;
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
   * Task-mode gate — when the user approved `submit_tasks` with
   * `execution_mode='all-subagent'`, refuse mutating tool calls that
   * would bypass `execute_task`. Returns refusal text or null.
   */
  enforceTaskMode?: (toolName: string, toolMutates: boolean) => string | null;
  /**
   * Smart-reducer post-result hook. Receives the raw tool result content
   * and returns a possibly-shortened version (tool-aware truncation, e.g.
   * git_log keeps the head commits, grep keeps the first matches).
   */
  reduceToolResult?: (toolName: string, content: string) => string;
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
   * Deep-think pre-think — calls an auxiliary cheap model BEFORE the
   * main provider.chat() to produce a reasoning block that gets
   * prefilled onto the conversation. Failures must NOT block the
   * main turn — the callback handles its own error events.
   */
  runPreThink?: (args: {
    messages: AgentMessage[];
    toolNames: string[];
    turn: number;
  }) => Promise<{ text: string; usage?: ChatUsage } | null>;
  /**
   * Quality watchdog — fire-and-forget classifier triggered AFTER each
   * turn finishes. The callback is expected to schedule the LLM call
   * asynchronously and emit `quality_watchdog_alert` when relevant.
   * The Executing node MUST NOT await this — degrades silently if it
   * throws synchronously.
   */
  runQualityCheck?: (args: {
    turn: number;
    assistantText: string;
    toolResults: Array<{ name: string; input: unknown; content: string; isError: boolean }>;
  }) => void;
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
  ) => Promise<ReadonlyArray<{ id: string; title: string; content: string }>>;
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
   * Inject a steering `<system-reminder>` as a user message that lands at
   * the START of the next turn (wraps `runner.pushUserMessage`). Used by the
   * Executing node to deliver loop-enforcement text when the same call has
   * been refused across multiple planning cycles. No-op when unset.
   */
  injectSystemReminder?: (text: string) => void;
  /**
   * Per-turn telemetry persistence — wraps the pure
   * `core/runner/telemetry/persist-turn.ts` helper with class-bound side
   * effects (quality classifier dispatch + tool-selection feedback
   * observer). Returns the inserted `coder_turn_telemetry.id` so the
   * Executing node can update `ctx.lastTurnTelemetryId` for the host's
   * `flushPendingTurn` to consume.
   *
   * Unset on subagents / standalone tests — the BT then skips
   * persistence entirely (no-op, no row, no error).
   */
  persistTurnTelemetry?: (input: {
    turn: number;
    usage: import('@mcp/code-agent/core/messages.js').ChatUsage | null;
    toolUseBlocks: ReadonlyArray<import('@mcp/code-agent/core/messages.js').ToolUseBlock>;
    toolResultBlocks: ReadonlyArray<import('@mcp/code-agent/core/messages.js').ContentBlock>;
    historyChars: number;
    systemPromptChars: number;
    toolsDefChars: number;
    responseMeta: import('@mcp/code-agent/core/messages.js').ChatProviderResponseMeta | null;
    compactionTriggered: boolean;
    summarizerRan: boolean;
  }) => number | null;
}

/** Transition table shape: `TRANSITIONS[state][event.kind] = nextState`. */
export type TransitionTable = Readonly<
  Record<NodeState, Partial<Record<BehaviorEventKind, NodeState>>>
>;
