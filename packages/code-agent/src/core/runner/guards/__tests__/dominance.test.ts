/**
 * Unit tests for the dominance guard's pure logic. Window/ratio are passed
 * explicitly so these never depend on env. W=5, R=0.8 → a tool must own
 * ceil(0.8*5)=4 of the 5-turn window (with zero text) to fire.
 */
import { describe, it, expect } from 'vitest';
import {
  checkDominance,
  createDominanceState,
  resetDominanceState,
  type DominanceState,
} from '../dominance.js';

const W = 5;
const R = 0.8;

function feed(
  state: DominanceState,
  turns: Array<{ name: string; hadText?: boolean }>,
): ReturnType<typeof checkDominance> {
  let v: ReturnType<typeof checkDominance> = { fired: false };
  for (const t of turns) {
    v = checkDominance({ toolName: t.name, hadText: !!t.hadText, state, window: W, ratio: R });
  }
  return v;
}

describe('checkDominance', () => {
  it('does not fire before the window is full', () => {
    const s = createDominanceState();
    expect(feed(s, Array(W - 1).fill({ name: 'read_file' }))).toEqual({ fired: false });
  });

  it('fires when one tool fills the window with zero text', () => {
    const s = createDominanceState();
    const v = feed(s, Array(W).fill({ name: 'read_file' }));
    expect(v.fired).toBe(true);
    if (v.fired) {
      expect(v.toolName).toBe('read_file');
      expect(v.count).toBe(W);
    }
  });

  it('stays quiet if any window turn carried assistant text', () => {
    const s = createDominanceState();
    const turns = Array(W).fill(0).map(() => ({ name: 'read_file', hadText: false }));
    turns[2].hadText = true; // one narrated turn breaks the grind signal
    expect(feed(s, turns)).toEqual({ fired: false });
  });

  it('stays quiet when no single tool reaches the ratio', () => {
    const s = createDominanceState();
    // read_file×3, grep×2 over the 5-window → top is 3 < need(4).
    const v = feed(s, [
      { name: 'read_file' }, { name: 'grep' }, { name: 'read_file' },
      { name: 'grep' }, { name: 'read_file' },
    ]);
    expect(v).toEqual({ fired: false });
  });

  it('blank names (all-polling turns) cannot dominate', () => {
    const s = createDominanceState();
    expect(feed(s, Array(W).fill({ name: '' }))).toEqual({ fired: false });
  });

  it('slides the window so older turns age out', () => {
    const s = createDominanceState();
    // Seed 3 mixed turns (no dominance), then 5 read_file pushes them out so
    // the full window is pure read_file → fires.
    feed(s, [{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
    const v = feed(s, Array(W).fill({ name: 'read_file' }));
    expect(v.fired).toBe(true);
    if (v.fired) expect(v.toolName).toBe('read_file');
  });

  it('resetDominanceState clears the window', () => {
    const s = createDominanceState();
    feed(s, Array(W).fill({ name: 'read_file' }));
    resetDominanceState(s);
    expect(s.window).toHaveLength(0);
  });
});
