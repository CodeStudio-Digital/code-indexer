import { describe, expect, it } from 'vitest';
import { replaceFrameIfCurrent, replaceWithBaseTimeline } from '../useTimelineOps.js';
import type { AnimFrame } from '../api-anim.js';

describe('replaceWithBaseTimeline', () => {
  it('rebuilds a clean base track and drops overlay cells', () => {
    expect(replaceWithBaseTimeline([31, 32, 33])).toEqual([
      { id: -1, frameIndex: 0, versionId: 31, durationMs: null, track: 0 },
      { id: -1, frameIndex: 1, versionId: 32, durationMs: null, track: 0 },
      { id: -1, frameIndex: 2, versionId: 33, durationMs: null, track: 0 },
    ]);
  });
});

describe('replaceFrameIfCurrent', () => {
  const frames: AnimFrame[] = [
    { id: 1, frameIndex: 0, versionId: 10, durationMs: null, track: 0 },
    { id: 2, frameIndex: 0, versionId: 20, durationMs: null, track: 1 },
  ];

  it('replaces the targeted cell when the expected version still matches', () => {
    expect(replaceFrameIfCurrent(frames, 1, 0, 21, 20)).toEqual([
      frames[0],
      { id: 2, frameIndex: 0, versionId: 21, durationMs: null, track: 1 },
    ]);
  });

  it('returns the same frame array when the target moved before pick', () => {
    expect(replaceFrameIfCurrent(frames, 1, 0, 21, 99)).toBe(frames);
  });
});
