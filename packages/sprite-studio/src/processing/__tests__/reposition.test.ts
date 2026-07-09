import { describe, expect, it } from 'vitest';
import { repositionSubjectOnCanvas } from '../reposition.js';
import type { RgbaImage } from '../types.js';

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

function opaqueAt(image: RgbaImage): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (image.rgba[(y * image.width + x) * 4 + 3] > 0) out.push([x, y]);
    }
  }
  return out;
}

const T = [0, 0, 0, 0];
const W = [255, 255, 255, 255];
const R = [255, 0, 0, 255];
const B = [0, 0, 255, 255];

describe('repositionSubjectOnCanvas', () => {
  it('moves transparent-frame content without changing canvas dimensions', () => {
    const source = img(4, 3, [
      T, T, T, T,
      T, R, B, T,
      T, T, T, T,
    ]);
    const out = repositionSubjectOnCanvas(source, { dx: 1, dy: -1 });
    expect([out.width, out.height]).toEqual([4, 3]);
    expect(opaqueAt(out)).toEqual([[2, 0], [3, 0]]);
    expect(px(out, 2, 0)).toEqual(R);
    expect(px(out, 3, 0)).toEqual(B);
  });

  it('does not move an opaque white/flat background with the subject', () => {
    const source = img(4, 4, [
      W, W, W, W,
      W, R, B, W,
      W, W, W, W,
      W, W, W, W,
    ]);
    const out = repositionSubjectOnCanvas(source, { dx: 1, dy: 1 });
    expect([out.width, out.height]).toEqual([4, 4]);
    expect(opaqueAt(out)).toEqual([[2, 2], [3, 2]]);
    expect(px(out, 2, 2)).toEqual(R);
    expect(px(out, 3, 2)).toEqual(B);
    expect(px(out, 0, 0)[3]).toBe(0);
  });

  it('clips moved content at the fixed canvas edge', () => {
    const source = img(3, 2, [
      R, B, T,
      T, T, T,
    ]);
    const out = repositionSubjectOnCanvas(source, { dx: -1, dy: 0 });
    expect([out.width, out.height]).toEqual([3, 2]);
    expect(opaqueAt(out)).toEqual([[0, 0]]);
    expect(px(out, 0, 0)).toEqual(B);
  });

  it('rejects non-integer offsets and invalid background tolerance', () => {
    expect(() => repositionSubjectOnCanvas(img(1, 1, [R]), { dx: 0.5, dy: 0 })).toThrow(/dx/);
    expect(() => repositionSubjectOnCanvas(img(1, 1, [R]), { dx: 0, dy: 0, backgroundTolerance: 999 }))
      .toThrow(/backgroundTolerance/);
  });
});
