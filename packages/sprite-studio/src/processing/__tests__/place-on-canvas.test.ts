import { describe, expect, it } from 'vitest';
import { centerOnCanvas, placeOnCanvas } from '../auto-crop.js';
import { runPipeline } from '../ops.js';
import type { RgbaImage } from '../types.js';

/** Build an image from per-pixel [r,g,b,a] rows (row-major). */
function img(width: number, height: number, pixels: number[][]): RgbaImage {
  if (pixels.length !== width * height) throw new Error('pixel count mismatch');
  const rgba = new Uint8Array(width * height * 4);
  pixels.forEach((p, i) => rgba.set(p, i * 4));
  return { rgba, width, height };
}

function px(image: RgbaImage, x: number, y: number): number[] {
  const i = (y * image.width + x) * 4;
  return Array.from(image.rgba.subarray(i, i + 4));
}

/** Coordinates of every alpha>0 pixel (registration checks). */
function opaqueAt(image: RgbaImage): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (image.rgba[(y * image.width + x) * 4 + 3] > 0) out.push([x, y]);
    }
  }
  return out;
}

const R: number[] = [255, 0, 0, 255];
const dot = img(1, 1, [R]);

describe('placeOnCanvas', () => {
  it('lands a 1x1 dot on every corner/center of a 3x3 canvas', () => {
    const cases: Array<[Parameters<typeof placeOnCanvas>[1], [number, number]]> = [
      [{ width: 3, height: 3, anchorX: 'left', anchorY: 'top' }, [0, 0]],
      [{ width: 3, height: 3, anchorX: 'right', anchorY: 'top' }, [2, 0]],
      [{ width: 3, height: 3, anchorX: 'left', anchorY: 'bottom' }, [0, 2]],
      [{ width: 3, height: 3, anchorX: 'right', anchorY: 'bottom' }, [2, 2]],
      [{ width: 3, height: 3, anchorX: 'center', anchorY: 'middle' }, [1, 1]],
      [{ width: 3, height: 3, anchorX: 'center', anchorY: 'bottom' }, [1, 2]],
    ];
    for (const [params, [x, y]] of cases) {
      const out = placeOnCanvas(dot, params);
      expect([out.width, out.height]).toEqual([3, 3]);
      expect(opaqueAt(out)).toEqual([[x, y]]);
      expect(px(out, x, y)).toEqual(R);
    }
  });

  it('defaults to center/middle and rounds like centerOnCanvas on even leftover space', () => {
    const out = placeOnCanvas(dot, { width: 4, height: 4 });
    // Math.round((4-1)/2) = 2 — must match the centerOnCanvas convention.
    expect(opaqueAt(out)).toEqual([[2, 2]]);
    expect(out.rgba).toEqual(centerOnCanvas(dot, { width: 4, height: 4 }).rgba);
  });

  it('reproduces centerOnCanvas bottom alignment exactly (back-compat contract)', () => {
    const sprite = img(2, 1, [R, [0, 255, 0, 255]]);
    const placed = placeOnCanvas(sprite, { width: 5, height: 4, anchorX: 'center', anchorY: 'bottom' });
    const centered = centerOnCanvas(sprite, { width: 5, height: 4, align: 'bottom' });
    expect(placed.rgba).toEqual(centered.rgba);
  });

  it('clips content that falls outside the canvas', () => {
    const wide = img(3, 1, [[1, 1, 1, 255], [2, 2, 2, 255], [3, 3, 3, 255]]);
    const out = placeOnCanvas(wide, { width: 2, height: 2, anchorX: 'right', anchorY: 'top' });
    // ox = 2-3 = -1 → the leftmost source pixel is clipped away.
    expect(px(out, 0, 0)).toEqual([2, 2, 2, 255]);
    expect(px(out, 1, 0)).toEqual([3, 3, 3, 255]);
    expect(px(out, 0, 1)[3]).toBe(0);
  });

  it('rejects invalid canvas dimensions', () => {
    expect(() => placeOnCanvas(dot, { width: 0, height: 3 })).toThrow(/Invalid canvas/);
    expect(() => placeOnCanvas(dot, { width: 3.5, height: 3 })).toThrow(/Invalid canvas/);
  });
});

describe('placeOnCanvas via runPipeline (frame-alignment recipe)', () => {
  it('autoCrop + placeOnCanvas re-anchors a drifted sprite to bottom-center', () => {
    // 4x4 canvas, 1px sprite drifted to the top-right corner.
    const T: number[] = [0, 0, 0, 0];
    const pixels: number[][] = Array.from({ length: 16 }, () => T);
    pixels[3] = R; // (3,0)
    const out = runPipeline(img(4, 4, pixels), [
      { op: 'autoCrop' },
      { op: 'placeOnCanvas', width: 4, height: 4, anchorX: 'center', anchorY: 'bottom' },
    ]);
    expect(opaqueAt(out)).toEqual([[2, 3]]); // Math.round((4-1)/2)=2, bottom row
  });
});
