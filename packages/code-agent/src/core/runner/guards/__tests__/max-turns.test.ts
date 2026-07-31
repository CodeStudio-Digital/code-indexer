/**
 * Unit tests for the max-turns guard.
 *
 * Key invariant: each consumed auto-continue grants a fresh batch of
 * `maxTurns` turns, so the effective ceiling is `maxTurns × (1 + autoContinues)`.
 * The guard must `continue` WITHIN a granted batch and only `auto-continue`
 * when crossing each batch boundary — never once-per-turn.
 */
import { describe, it, expect } from 'vitest';
import { checkMaxTurns, maxAutoContinues } from '../max-turns.js';

describe('maxAutoContinues', () => {
  it('uses the session materialization default and ignores process env', () => {
    expect(maxAutoContinues()).toBe(15);
  });
});

describe('checkMaxTurns', () => {
  it('continues within the first batch', () => {
    expect(checkMaxTurns({ turn: 10, autoContinues: 0, maxTurns: 50 }).kind).toBe('continue');
  });

  it('auto-continues at the first batch boundary', () => {
    const verdict = checkMaxTurns(
      { turn: 50, autoContinues: 0, maxTurns: 50 },
      2,
    );
    expect(verdict.kind).toBe('auto-continue');
    if (verdict.kind === 'auto-continue') expect(verdict.nextCount).toBe(1);
  });

  it('treats a turn beyond the boundary the same as exactly at it', () => {
    expect(checkMaxTurns(
      { turn: 60, autoContinues: 0, maxTurns: 50 },
      2,
    ).kind).toBe('auto-continue');
  });

  // Regression: the old guard burned the whole budget one turn at a time
  // because it never extended the ceiling. A granted batch must let the model
  // keep working until the NEXT boundary.
  it('continues within a granted batch (does NOT auto-continue every turn)', () => {
    expect(checkMaxTurns(
      { turn: 75, autoContinues: 1, maxTurns: 50 },
      2,
    ).kind).toBe('continue');
    expect(checkMaxTurns(
      { turn: 99, autoContinues: 1, maxTurns: 50 },
      2,
    ).kind).toBe('continue');
  });

  it('auto-continues at the second batch boundary', () => {
    const verdict = checkMaxTurns(
      { turn: 100, autoContinues: 1, maxTurns: 50 },
      2,
    );
    expect(verdict.kind).toBe('auto-continue');
    if (verdict.kind === 'auto-continue') expect(verdict.nextCount).toBe(2);
  });

  it('stops once the final batch is exhausted', () => {
    // cap=3 → total budget = 50 × (1 + 3) = 200 turns.
    expect(checkMaxTurns(
      { turn: 200, autoContinues: 3, maxTurns: 50 },
      3,
    ).kind).toBe('stop');
  });

  it('honours the session-provided cap', () => {
    // Still gets one full extra batch...
    expect(checkMaxTurns(
      { turn: 60, autoContinues: 0, maxTurns: 50 },
      1,
    ).kind).toBe('auto-continue');
    expect(checkMaxTurns(
      { turn: 75, autoContinues: 1, maxTurns: 50 },
      1,
    ).kind).toBe('continue');
    // ...then stops at the second boundary (budget = 50 × 2 = 100).
    expect(checkMaxTurns(
      { turn: 100, autoContinues: 1, maxTurns: 50 },
      1,
    ).kind).toBe('stop');
  });

  it('supports an exact per-run ceiling when auto-continue cap is zero', () => {
    expect(checkMaxTurns({ turn: 12, autoContinues: 0, maxTurns: 12 }, 0))
      .toEqual({ kind: 'stop' });
  });
});
