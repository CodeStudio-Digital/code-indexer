import { describe, expect, it } from 'vitest';
import { replaceFrameIfCurrent, replaceWithBaseTimeline } from '../useTimelineOps.js';
import type { AnimFrame } from '../api-anim.js';

const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;

describe('replaceWithBaseTimeline', () => {
  it('rebuilds a clean base track and drops overlay cells', () => {
    expect(replaceWithBaseTimeline([uuid(31), uuid(32), uuid(33)])).toEqual([
      { id: `draft:0:0:${uuid(31)}`, frameIndex: 0, versionId: uuid(31), durationMs: null, track: 0 },
      { id: `draft:0:1:${uuid(32)}`, frameIndex: 1, versionId: uuid(32), durationMs: null, track: 0 },
      { id: `draft:0:2:${uuid(33)}`, frameIndex: 2, versionId: uuid(33), durationMs: null, track: 0 },
    ]);
  });
});

describe('replaceFrameIfCurrent', () => {
  const frames: AnimFrame[] = [
    { id: uuid(1), frameIndex: 0, versionId: uuid(10), durationMs: null, track: 0 },
    { id: uuid(2), frameIndex: 0, versionId: uuid(20), durationMs: null, track: 1 },
  ];

  it('replaces the targeted cell when the expected version still matches', () => {
    expect(replaceFrameIfCurrent(frames, 1, 0, uuid(21), uuid(20))).toEqual([
      frames[0],
      {
        id: `draft:1:0:${uuid(21)}`,
        frameIndex: 0,
        versionId: uuid(21),
        durationMs: null,
        track: 1,
      },
    ]);
  });

  it('returns the same frame array when the target moved before pick', () => {
    expect(replaceFrameIfCurrent(frames, 1, 0, uuid(21), uuid(99))).toBe(frames);
  });
});
