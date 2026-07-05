import { describe, expect, it } from 'vitest';
import { clampResliceNudge, computeResliceLayout, resliceCellRect } from '../reslice-geometry.js';

describe('reslice geometry', () => {
  it('matches backend floor-based cell sizing for sheets with remainders', () => {
    const layout = computeResliceLayout({
      width: 101,
      height: 67,
      cols: 4,
      rows: 3,
      offsetX: 2,
      offsetY: 1,
      marginX: 3,
      marginY: 2,
    });

    expect(layout.cellW).toBe(24);
    expect(layout.cellH).toBe(21);
    expect(resliceCellRect(layout, 6)).toEqual({ x: 50, y: 22, w: 24, h: 21 });
  });

  it('clamps nudged crop windows inside the source sheet', () => {
    const layout = computeResliceLayout({ width: 64, height: 64, cols: 2, rows: 2 });

    expect(clampResliceNudge(layout, 0, { dx: -99, dy: -99 })).toEqual({ dx: 0, dy: 0 });
    expect(clampResliceNudge(layout, 3, { dx: 99, dy: 99 })).toEqual({ dx: 0, dy: 0 });
    expect(resliceCellRect(layout, 1, { dx: -10.4, dy: 3.6 })).toEqual({ x: 22, y: 4, w: 32, h: 32 });
  });
});
