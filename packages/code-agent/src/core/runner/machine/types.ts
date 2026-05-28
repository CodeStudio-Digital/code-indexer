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
  | { kind: 'ToolLoopDetected'; guard: 'tuple-hash' | 'doom-loop' | 'dominance' }
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
  autoContinues: number;
  /** Stable run id (uuid) for telemetry correlation. */
  runId: string;
  aborted: boolean;
  /** Recovery path that led to termination (RunResult.transition). */
  transition: TransitionKind | null;
  /** Final stop reason — set by a node BEFORE emitting CleanFinish/Aborted. */
  stopReason: StopReason | null;
  /** Underlying error for failure modes. */
  error: Error | null;
  /**
   * Optional bridge to features still owned by the legacy `CoderRunner`.
   * When unset the BT uses safe defaults (no skills, no quality suffix,
   * no plan-mode gate, etc.).
   */
  bridge?: BridgeCallbacks;
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
  enforcePreRead?: (toolName: string, input: unknown, turn: number) => string | null;
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
}

/** Transition table shape: `TRANSITIONS[state][event.kind] = nextState`. */
export type TransitionTable = Readonly<
  Record<NodeState, Partial<Record<BehaviorEventKind, NodeState>>>
>;
