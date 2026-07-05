/**
 * sliceGridAdvanced — custom re-slice with offset/margin. Backs the "keep the
 * original sheet + re-cut it" feature.
 */
import { describe, it, expect } from 'vitest';
import { sliceGrid, sliceGridAdvanced } from '../slice.js';
import type { RgbaImage } from '../types.js';

const img = (w: number, h: number): RgbaImage => ({ rgba: new Uint8Array(w * h * 4), width: w, height: h });

describe('sliceGridAdvanced', () => {
  it('cuts equal cells over the usable region defined by offset + margin', () => {
    // usable width = 20 - 2(offset) - 2(margin) = 16 → 2 cells of 8px.
    const cells = sliceGridAdvanced(img(20, 10), { cols: 2, rows: 1, offsetX: 2, marginX: 2 });
    expect(cells).toHaveLength(2);
    expect(cells[0]).toMatchObject({ width: 8, height: 10 });
  });

  it('equals the plain grid at zero offset/margin', () => {
    const a = sliceGridAdvanced(img(12, 6), { cols: 3, rows: 2 });
    const b = sliceGrid(img(12, 6), 3, 2);
    expect(a.map((c) => [c.width, c.height])).toEqual(b.map((c) => [c.width, c.height]));
  });

  it('throws when the usable area is too small for the grid', () => {
    expect(() => sliceGridAdvanced(img(4, 4), { cols: 5, rows: 1 })).toThrow();
  });

  // A 20×1 sheet whose red channel encodes the x coordinate, so we can read
  // back WHICH source column each cell started at.
  const xRamp = (w: number): RgbaImage => {
    const rgba = new Uint8Array(w * 4);
    for (let x = 0; x < w; x++) rgba[x * 4] = x;
    return { rgba, width: w, height: 1 };
  };

  it('nudges an individual cell crop by its per-cell offset (row-major)', () => {
    // cols=2 → cellW=10. Nudge cell 0 right by 5px; cell 1 stays put.
    const cells = sliceGridAdvanced(xRamp(20), { cols: 2, rows: 1, offsets: [{ dx: 5, dy: 0 }] });
    expect(cells[0].rgba[0]).toBe(5); // cell 0 now starts at source x=5
    expect(cells[1].rgba[0]).toBe(10); // cell 1 unchanged at x=10
  });

  it('clamps a per-cell nudge so the crop stays inside the sheet', () => {
    // cellW=10 → maxX=10; a huge nudge clamps the window to x=10.
    const cells = sliceGridAdvanced(xRamp(20), { cols: 2, rows: 1, offsets: [{ dx: 999, dy: 0 }] });
    expect(cells[0].rgba[0]).toBe(10);
  });
});
