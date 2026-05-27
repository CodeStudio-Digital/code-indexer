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
  /** Always contains 'bootstrap'. Invariant enforced by `ensureBootstrap`. */
  activeTiers: Set<ToolTier>;
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

/** Transition table shape: `TRANSITIONS[state][event.kind] = nextState`. */
export type TransitionTable = Readonly<
  Record<NodeState, Partial<Record<BehaviorEventKind, NodeState>>>
>;
