/**
 * Combinatorial coverage for the Behavior Tree transition table.
 *
 * The legacy `while (turn<maxTurns)` loop's control flow lived in scattered
 * `continue`s and flags — impossible to audit without reading 4k lines.
 * Here the table is data, and these tests assert the four invariants the
 * orchestrator relies on:
 *
 *   1. Every declared target points at a valid NodeState.
 *   2. `Done` is terminal (zero outgoing transitions).
 *   3. Every non-Done state has at least one outgoing transition.
 *   4. `Aborted` always lands on `Done` regardless of source.
 */
import { describe, it, expect } from 'vitest';
import {
  ALL_EVENT_KINDS,
  ALL_NODE_STATES,
  TRANSITIONS,
  nextState,
} from '../transitions.js';
import { events } from '../events.js';

describe('Behavior Tree transitions', () => {
  it('every declared target is a valid NodeState', () => {
    for (const state of ALL_NODE_STATES) {
      for (const eventKind of ALL_EVENT_KINDS) {
        const target = TRANSITIONS[state][eventKind];
        if (target === undefined) continue;
        expect(ALL_NODE_STATES, `${state}/${eventKind} → ${target}`).toContain(target);
      }
    }
  });

  it('Done is terminal (no outgoing transitions)', () => {
    expect(Object.keys(TRANSITIONS.Done)).toHaveLength(0);
  });

  it('every non-Done state has at least one outgoing transition', () => {
    for (const state of ALL_NODE_STATES) {
      if (state === 'Done') continue;
      expect(
        Object.keys(TRANSITIONS[state]).length,
        `${state} has no transitions`,
      ).toBeGreaterThan(0);
    }
  });

  it('Aborted always lands on Done', () => {
    for (const state of ALL_NODE_STATES) {
      if (state === 'Done') continue;
      expect(nextState(state, events.aborted()), state).toBe('Done');
    }
  });

  it('nextState falls through to Done for unmapped pairs', () => {
    // Bootstrap has no mapping for TokenThresholdHit → must default to Done.
    expect(nextState('Bootstrap', events.tokenThresholdHit({ ratio: 0.9 }))).toBe('Done');
  });

  it('Executing routes the canonical event set correctly', () => {
    expect(nextState('Executing', events.turnSucceeded({ hasToolCalls: true }))).toBe('Executing');
    expect(nextState('Executing', events.tokenThresholdHit({ ratio: 0.91 }))).toBe('Compacting');
    expect(nextState('Executing', events.toolLoopDetected({ guard: 'tuple-hash' }))).toBe('Planning');
    expect(nextState('Executing', events.maxTurnsReached({ autoContinueLeft: 0 }))).toBe('Reviewing');
    expect(nextState('Executing', events.providerError({ retryable: true, status: 500 }))).toBe('Recovering');
    expect(nextState('Executing', events.cleanFinish())).toBe('Done');
  });

  it('Compacting only proceeds via CompactionDone or ProviderError', () => {
    expect(nextState('Compacting', events.compactionDone({ collapsedFrom: 100, collapsedTo: 40 }))).toBe('Reviewing');
    expect(nextState('Compacting', events.providerError({ retryable: false, status: 500 }))).toBe('Recovering');
    expect(nextState('Compacting', events.toolLoopDetected({ guard: 'tuple-hash' }))).toBe('Done');
  });

  it('Planning loops back to Executing on success', () => {
    expect(nextState('Planning', events.turnSucceeded({ hasToolCalls: false }))).toBe('Executing');
  });

  it('Reviewing forks: Executing on continue, Done on clean finish', () => {
    expect(nextState('Reviewing', events.turnSucceeded({ hasToolCalls: true }))).toBe('Executing');
    expect(nextState('Reviewing', events.cleanFinish())).toBe('Done');
  });

  it('Recovering stays on Recovering for repeated provider errors', () => {
    expect(nextState('Recovering', events.providerError({ retryable: true, status: 503 }))).toBe('Recovering');
    expect(nextState('Recovering', events.turnSucceeded({ hasToolCalls: false }))).toBe('Executing');
  });
});
