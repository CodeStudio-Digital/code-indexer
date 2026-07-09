import { describe, expect, it } from 'vitest';
import { normalizeRepositionFrameInput } from '../frames-reposition.routes.js';

describe('normalizeRepositionFrameInput', () => {
  it('accepts integer frame index and offsets, defaulting to base track', () => {
    expect(normalizeRepositionFrameInput({ frameIndex: 2, dx: -3, dy: 4 })).toEqual({
      frameIndex: 2,
      dx: -3,
      dy: 4,
      track: 0,
    });
  });

  it('accepts an explicit non-negative track', () => {
    expect(normalizeRepositionFrameInput({ frameIndex: 1, dx: 5, dy: -6, track: 2 })).toEqual({
      frameIndex: 1,
      dx: 5,
      dy: -6,
      track: 2,
    });
  });

  it.each([
    null,
    {},
    { frameIndex: -1, dx: 1, dy: 1 },
    { frameIndex: 1.5, dx: 1, dy: 1 },
    { frameIndex: 1, dx: 0, dy: 0 },
    { frameIndex: 1, dx: 0.5, dy: 1 },
    { frameIndex: 1, dx: 1, dy: 2049 },
    { frameIndex: 1, dx: 1, dy: 1, track: -1 },
    { frameIndex: 1, dx: 1, dy: 1, track: 1.5 },
  ])('rejects invalid payload %#', (value) => {
    expect(() => normalizeRepositionFrameInput(value)).toThrow(/invalid_body|invalid_offset|invalid_track|no_offset/);
  });
});
