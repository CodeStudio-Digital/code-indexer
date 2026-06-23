import { describe, it, expect } from 'vitest';
import { slidingWindows } from '../sliding-window.js';

const OPTS = { windowChars: 100, overlapChars: 20, maxChunks: 4 };

describe('slidingWindows', () => {
  it('returns a single chunk equal to the input when it fits', () => {
    expect(slidingWindows('short', OPTS)).toEqual(['short']);
    const exact = 'a'.repeat(100);
    expect(slidingWindows(exact, OPTS)).toEqual([exact]);
  });

  it('splits long text into overlapping windows stepping by window-overlap', () => {
    const text = 'a'.repeat(250); // > window(100); step = 80
    const out = slidingWindows(text, OPTS);
    // starts at 0, 80, 160, 240 → 4 windows (capped at maxChunks=4)
    expect(out).toHaveLength(4);
    expect(out[0]).toHaveLength(100); // [0,100)
    expect(out[1]).toHaveLength(100); // [80,180)
    // 20-char overlap: tail of chunk 0 equals head of chunk 1.
    expect(out[0].slice(-20)).toBe(out[1].slice(0, 20));
  });

  it('honors maxChunks, dropping the far tail', () => {
    const text = 'a'.repeat(10_000);
    const out = slidingWindows(text, { windowChars: 100, overlapChars: 20, maxChunks: 3 });
    expect(out).toHaveLength(3);
  });

  it('maxChunks=1 truncates to a single window (legacy behavior)', () => {
    const text = 'b'.repeat(500);
    const out = slidingWindows(text, { windowChars: 100, overlapChars: 20, maxChunks: 1 });
    expect(out).toEqual(['b'.repeat(100)]);
  });

  it('clamps overlap below window size so step stays positive', () => {
    const text = 'c'.repeat(300);
    const out = slidingWindows(text, { windowChars: 50, overlapChars: 999, maxChunks: 10 });
    // overlap clamped to 49 → step 1, but maxChunks caps the count.
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out[0]).toHaveLength(50);
  });
});
