/**
 * Declarative state machine transition table.
 *
 *   next(state, event) = TRANSITIONS[state][event.kind] ?? 'Done'
 *
 * Adding a new transition requires editing exactly this file — no flags, no
 * implicit fallthrough, no scattered `if`s. The companion test suite (see
 * `__tests__/transitions.test.ts`) enforces:
 *   - every declared target is a valid NodeState,
 *   - `Done` is terminal,
 *   - every non-Done state has at least one outgoing transition,
 *   - `Aborted` always lands on `Done` regardless of source state.
 */
import type {
  BehaviorEvent,
  BehaviorEventKind,
  NodeState,
  TransitionTable,
} from './types.js';

export const TRANSITIONS: TransitionTable = {
  Bootstrap: {
    TurnSucceeded: 'Executing',
    ToolOutcomeUnknown: 'Done',
    Aborted: 'Done',
  },
  Executing: {
    TurnSucceeded: 'Executing',
    TokenThresholdHit: 'Compacting',
    ToolLoopDetected: 'Planning',
    ToolOutcomeUnknown: 'Done',
    MaxTurnsReached: 'Reviewing',
    ProviderError: 'Recovering',
    CleanFinish: 'Done',
    Aborted: 'Done',
  },
  Planning: {
    TurnSucceeded: 'Executing',
    Aborted: 'Done',
  },
  Compacting: {
    CompactionDone: 'Reviewing',
    ProviderError: 'Recovering',
    Aborted: 'Done',
  },
  Reviewing: {
    TurnSucceeded: 'Executing',
    CleanFinish: 'Done',
    Aborted: 'Done',
  },
  Recovering: {
    TurnSucceeded: 'Executing',
    // Context-overflow provider errors route to Compacting (shrink the
    // history) instead of re-sending the same oversized payload.
    TokenThresholdHit: 'Compacting',
    ProviderError: 'Recovering',
    Aborted: 'Done',
  },
  Done: {},
};

/**
 * Pure transition function. Unmapped event kinds default to `'Done'` so any
 * "fell through unhandled" path becomes visible in tests and telemetry.
 */
export function nextState(state: NodeState, event: BehaviorEvent): NodeState {
  return TRANSITIONS[state][event.kind] ?? 'Done';
}

/** Enumeration of every event kind. Exported for combinatorial tests. */
export const ALL_EVENT_KINDS: readonly BehaviorEventKind[] = [
  'TurnSucceeded',
  'TokenThresholdHit',
  'ToolLoopDetected',
  'ToolOutcomeUnknown',
  'MaxTurnsReached',
  'ProviderError',
  'CompactionDone',
  'CleanFinish',
  'Aborted',
] as const;

/** Enumeration of every node state. Exported for combinatorial tests. */
export const ALL_NODE_STATES: readonly NodeState[] = [
  'Bootstrap',
  'Planning',
  'Executing',
  'Compacting',
  'Reviewing',
  'Recovering',
  'Done',
] as const;
