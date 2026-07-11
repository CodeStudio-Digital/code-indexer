import { describe, expect, it } from 'vitest';
import { NoProgressTracker } from '../no-progress.js';

const base = {
  name: 'git_status',
  normalizedInput: {},
  content: 'clean',
  isError: false,
  repeatPolicy: 'volatile' as const,
  resultNovel: false,
  coverageNovel: false,
  productive: false,
};

describe('NoProgressTracker', () => {
  it('observes identical cross-turn results without blocking execution', () => {
    const tracker = new NoProgressTracker();
    expect(tracker.observe({ ...base, turn: 1, toolUseId: 'u1' })).toBeNull();
    expect(tracker.observe({ ...base, turn: 2, toolUseId: 'u2' })).toBeNull();
    expect(tracker.observe({ ...base, turn: 3, toolUseId: 'u3' })).toMatchObject({
      action: 'shadow',
      reason: 'cross-turn-no-progress',
      wouldBlock: true,
      count: 3,
    });
  });

  it('resets after a state-changing write/execute', () => {
    const tracker = new NoProgressTracker();
    tracker.observe({ ...base, turn: 1, toolUseId: 'u1' });
    tracker.observe({ ...base, turn: 2, toolUseId: 'u2' });
    expect(tracker.noteStateChange()).toBe(1);
    expect(tracker.observe({ ...base, turn: 3, toolUseId: 'u3' })).toBeNull();
  });

  it('does not overlap polling-stuck or failure-streak ownership', () => {
    const tracker = new NoProgressTracker();
    for (let turn = 1; turn <= 5; turn++) {
      expect(tracker.observe({
        ...base,
        repeatPolicy: 'pollable',
        turn,
        toolUseId: `u${turn}`,
      })).toBeNull();
    }
    expect(tracker.observe({ ...base, isError: true, turn: 6, toolUseId: 'u6' })).toBeNull();
  });

  it('never emits a cross-turn candidate for explicit force_reread calls', () => {
    const tracker = new NoProgressTracker();
    for (let turn = 1; turn <= 5; turn++) {
      expect(tracker.observe({
        ...base,
        normalizedInput: { path: 'a.ts', force_reread: true },
        turn,
        toolUseId: `u${turn}`,
      })).toBeNull();
    }
  });

  it('treats result or coverage novelty as progress', () => {
    const tracker = new NoProgressTracker();
    tracker.observe({ ...base, turn: 1, toolUseId: 'u1' });
    tracker.observe({ ...base, turn: 2, toolUseId: 'u2' });
    expect(tracker.observe({
      ...base,
      coverageNovel: true,
      turn: 3,
      toolUseId: 'u3',
    })).toBeNull();
  });
});
