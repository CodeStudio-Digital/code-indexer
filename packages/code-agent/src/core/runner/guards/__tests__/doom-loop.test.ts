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

  it('PR5: tolerates intercalated no-tool turns (fuzzy state survives)', () => {
    // The write_stdin loop pattern: 5 failures + 1 no-tool reasoning
    // turn + 1 more failure = 6 actual write_stdin calls across 7
    // turns. The pre-PR5 reset would wipe the fuzzy buffer on the
    // no-tool turn and the 6th call would only see itself in the
    // window. PR5 preserves the fuzzy buffer; the no-tool turn does
    // NOT push a signature, so the 6th call brings the window count
    // up to 6 — fires.
    const state = createDoomLoopState();
    for (let i = 0; i < 5; i++) {
      checkDoomLoop({
        blocks: [{ name: 'write_stdin', input: { session_id: `s${i}` } }],
        state,
      });
    }
    // No-tool turn (LLM reasoning). Strict resets, fuzzy is preserved.
    const noTool = checkDoomLoop({ blocks: [], state });
    expect(noTool.fired).toBe(false);
    expect(state.fuzzy.length).toBe(5);

    const verdict = checkDoomLoop({
      blocks: [{ name: 'write_stdin', input: { session_id: 's6' } }],
      state,
    });
    expect(verdict.fired).toBe(true);
    if (verdict.fired) expect(verdict.guard).toBe('doom-loop-fuzzy');
  });

  it('PR5: tolerance fires on 4-of-6 matches (default tolerance=2)', () => {
    // Window:   stdin, edit_file, stdin, edit_file, stdin, stdin
    // Matches for "stdin" sig = 4 → fires (THRESHOLD - TOLERANCE = 6-2 = 4).
    const state = createDoomLoopState();
    const stdin = { name: 'write_stdin', input: { session_id: 'x' } };
    const edit = { name: 'edit_file', input: { path: 'a.ts' } };
    checkDoomLoop({ blocks: [stdin], state });
    checkDoomLoop({ blocks: [edit], state });
    checkDoomLoop({ blocks: [stdin], state });
    checkDoomLoop({ blocks: [edit], state });
    checkDoomLoop({ blocks: [stdin], state });
    const verdict = checkDoomLoop({ blocks: [stdin], state });
    expect(verdict.fired).toBe(true);
    if (verdict.fired) {
      expect(verdict.guard).toBe('doom-loop-fuzzy');
      expect(verdict.count).toBe(4);
    }
  });

  it('PR5: does NOT fire on 3-of-6 matches (below tolerance threshold)', () => {
    const state = createDoomLoopState();
    const stdin = { name: 'write_stdin', input: { session_id: 'x' } };
    const edit = { name: 'edit_file', input: { path: 'a.ts' } };
    const grep = { name: 'mcp__grep_code', input: { pattern: 'q' } };
    checkDoomLoop({ blocks: [stdin], state });
    checkDoomLoop({ blocks: [edit], state });
    checkDoomLoop({ blocks: [grep], state });
    checkDoomLoop({ blocks: [stdin], state });
    checkDoomLoop({ blocks: [edit], state });
    const verdict = checkDoomLoop({ blocks: [stdin], state });
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

describe('checkDoomLoop — fuzzyEligible scope', () => {
  const onlyGoals = (n: string): boolean => n === 'create_goal';

  it('does NOT fuzzy-fire for non-eligible tools — reading 8 different files', () => {
    const state = createDoomLoopState();
    let v: ReturnType<typeof checkDoomLoop> = { fired: false };
    for (let i = 0; i < 8; i++) {
      v = checkDoomLoop({
        blocks: [{ name: 'read_file', input: { path: `f${i}.ts` } }],
        state,
        fuzzyEligible: onlyGoals,
      });
    }
    // Different paths → strict never matches; read_file not eligible → fuzzy
    // never accumulates. Legitimate exploration is never flagged.
    expect(v.fired).toBe(false);
  });

  it('does NOT fuzzy-fire for non-eligible edits — editing 8 different files', () => {
    const state = createDoomLoopState();
    let v: ReturnType<typeof checkDoomLoop> = { fired: false };
    for (let i = 0; i < 8; i++) {
      v = checkDoomLoop({
        blocks: [{ name: 'edit_file', input: { path: `f${i}.ts`, old: 'a', new: 'b' } }],
        state,
        fuzzyEligible: onlyGoals,
      });
    }
    expect(v.fired).toBe(false);
  });

  it('STILL fuzzy-fires for an eligible churn tool — create_goal with rotating args', () => {
    const state = createDoomLoopState();
    let v: ReturnType<typeof checkDoomLoop> = { fired: false };
    for (let i = 0; i < 6; i++) {
      v = checkDoomLoop({
        blocks: [{ name: 'create_goal', input: { text: `goal ${i}` } }],
        state,
        fuzzyEligible: onlyGoals,
      });
    }
    expect(v.fired).toBe(true);
    if (v.fired) expect(v.guard).toBe('doom-loop-fuzzy');
  });
});
