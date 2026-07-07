import { describe, expect, it } from 'vitest';
import { normalizeFrameIndexes } from '../frames-align.routes.js';

describe('normalizeFrameIndexes', () => {
  it('omits filtering when frameIndexes is absent', () => {
    expect(normalizeFrameIndexes(undefined)).toBeNull();
  });

  it('deduplicates valid non-negative integer frame indexes', () => {
    expect([...normalizeFrameIndexes([2, 0, 2, 5])!]).toEqual([2, 0, 5]);
  });

  it('rejects malformed frameIndexes payloads', () => {
    for (const value of [null, '0', [1.5], [-1], [Number.NaN], []]) {
      expect(() => normalizeFrameIndexes(value)).toThrow(/invalid_frame_indexes|no_frames/);
    }
  });
});
