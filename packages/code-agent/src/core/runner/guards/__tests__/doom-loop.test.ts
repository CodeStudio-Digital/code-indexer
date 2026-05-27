/**
 * Unit tests for the doom-loop backstop guard.
 *
 * Strict variant fires when N consecutive turns have byte-identical
 * tool-call signatures (default N=3 via `CODER_DOOM_LOOP_THRESHOLD`).
 * Fuzzy variant fires on name-only repetition (default N=6 via
 * `CODER_DOOM_LOOP_FUZZY_THRESHOLD`).
 *
 * Pure-text turns clear the rolling window — they are progress, not loop.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  checkDoomLoop,
  createDoomLoopState,
  resetDoomLoopState,
} from '../doom-loop.js';

beforeEach(() => {
  vi.stubEnv('CODER_DOOM_LOOP_THRESHOLD', '3');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('checkDoomLoop — strict', () => {
  it('does not fire on the first turn', () => {
    const state = createDoomLoopState();
    const verdict = checkDoomLoop({
      blocks: [{ name: 'read_file', input: { path: 'a.ts' } }],
      state,
    });
    expect(verdict.fired).toBe(false);
  });

  it('fires after 3 consecutive identical strict signatures', () => {
    const state = createDoomLoopState();
    const blocks = [{ name: 'read_file', input: { path: 'a.ts' } }];
    checkDoomLoop({ blocks, state });
    checkDoomLoop({ blocks, state });
    const verdict = checkDoomLoop({ blocks, state });
    expect(verdict.fired).toBe(true);
    if (verdict.fired) {
      expect(verdict.guard).toBe('doom-loop-strict');
      expect(verdict.count).toBe(3);
    }
  });

  it('does NOT fire when args differ across turns', () => {
    const state = createDoomLoopState();
    checkDoomLoop({ blocks: [{ name: 'read_file', input: { path: 'a.ts' } }], state });
    checkDoomLoop({ blocks: [{ name: 'read_file', input: { path: 'b.ts' } }], state });
    const verdict = checkDoomLoop({ blocks: [{ name: 'read_file', input: { path: 'c.ts' } }], state });
    expect(verdict.fired).toBe(false);
  });

  it('clears the window on a tool-free turn (pure-text reasoning)', () => {
    const state = createDoomLoopState();
    const blocks = [{ name: 'read_file', input: { path: 'a.ts' } }];
    checkDoomLoop({ blocks, state });
    checkDoomLoop({ blocks, state });
    checkDoomLoop({ blocks: [], state }); // pure text
    const verdict = checkDoomLoop({ blocks, state });
    expect(verdict.fired).toBe(false);
  });
});

describe('checkDoomLoop — fuzzy', () => {
  // `DOOM_LOOP_FUZZY_THRESHOLD` is a module-load constant (default 6), so
  // we live with the real default here. The fuzzy variant only fires when
  // the strict variant has NOT already fired — same tool names, different
  // args turn-after-turn.
  it('fires on 6 consecutive turns with the same tool name but different args', () => {
    const state = createDoomLoopState();
    let verdict: ReturnType<typeof checkDoomLoop> = { fired: false };
    for (let i = 0; i < 6; i++) {
      verdict = checkDoomLoop({
        blocks: [{ name: 'read_file', input: { path: `${i}.ts` } }],
        state,
      });
    }
    expect(verdict.fired).toBe(true);
    if (verdict.fired) {
      expect(verdict.guard).toBe('doom-loop-fuzzy');
    }
  });

  it('does NOT fire on 5 fuzzy-matching turns (below threshold)', () => {
    const state = createDoomLoopState();
    let verdict: ReturnType<typeof checkDoomLoop> = { fired: false };
    for (let i = 0; i < 5; i++) {
      verdict = checkDoomLoop({
        blocks: [{ name: 'read_file', input: { path: `${i}.ts` } }],
        state,
      });
    }
    expect(verdict.fired).toBe(false);
  });
});

describe('resetDoomLoopState', () => {
  it('clears both strict and fuzzy windows', () => {
    const state = createDoomLoopState();
    checkDoomLoop({ blocks: [{ name: 'x', input: {} }], state });
    checkDoomLoop({ blocks: [{ name: 'x', input: {} }], state });
    expect(state.strict.length).toBe(2);
    resetDoomLoopState(state);
    expect(state.strict.length).toBe(0);
    expect(state.fuzzy.length).toBe(0);
  });
});
