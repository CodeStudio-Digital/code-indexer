/**
 * Pixel-position tests for the pure geometric transforms (no DOM — Rasters).
 * Every pixel is tagged r=x, g=y so a misplaced pixel names its origin.
 */
import { describe, expect, it } from 'vitest';
import { createRaster, getPixel, setPixel, type Raster } from '../image-data.js';
import { flipHorizontal, flipVertical, rotate90 } from '../transform.js';

/** w×h raster where pixel (x,y) carries [x, y, 42, 255]. */
function tagged(w: number, h: number): Raster {
  const r = createRaster(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) setPixel(r, x, y, [x, y, 42, 255]);
  return r;
}

const at = (r: Raster, x: number, y: number) => getPixel(r, x, y);

describe('flipHorizontal', () => {
  it('mirrors columns, keeps dims, leaves the input untouched', () => {
    const src = tagged(3, 2);
    const out = flipHorizontal(src);
    expect([out.width, out.height]).toEqual([3, 2]);
    expect(at(out, 0, 0)).toEqual([2, 0, 42, 255]); // was rightmost
    expect(at(out, 2, 0)).toEqual([0, 0, 42, 255]); // was leftmost
    expect(at(out, 1, 1)).toEqual([1, 1, 42, 255]); // center column stays
    expect(at(src, 0, 0)).toEqual([0, 0, 42, 255]); // input pristine
  });

  it('is its own inverse', () => {
    const src = tagged(4, 3);
    expect([...flipHorizontal(flipHorizontal(src)).data]).toEqual([...src.data]);
  });
});

describe('flipVertical', () => {
  it('mirrors rows, keeps dims, leaves the input untouched', () => {
    const src = tagged(2, 3);
    const out = flipVertical(src);
    expect([out.width, out.height]).toEqual([2, 3]);
    expect(at(out, 0, 0)).toEqual([0, 2, 42, 255]); // was bottom row
    expect(at(out, 1, 2)).toEqual([1, 0, 42, 255]); // was top row
    expect(at(out, 0, 1)).toEqual([0, 1, 42, 255]); // middle row stays
    expect(at(src, 0, 0)).toEqual([0, 0, 42, 255]);
  });

  it('is its own inverse', () => {
    const src = tagged(3, 4);
    expect([...flipVertical(flipVertical(src)).data]).toEqual([...src.data]);
  });
});

describe('rotate90 (clockwise)', () => {
  it('swaps dims and maps (x,y) → (h-1-y, x)', () => {
    const src = tagged(3, 2); // 3 wide, 2 tall
    const out = rotate90(src);
    expect([out.width, out.height]).toEqual([2, 3]); // dims swapped
    expect(at(out, 1, 0)).toEqual([0, 0, 42, 255]); // top-left → top-right
    expect(at(out, 1, 2)).toEqual([2, 0, 42, 255]); // top-right → bottom-right
    expect(at(out, 0, 0)).toEqual([0, 1, 42, 255]); // bottom-left → top-left
    expect(at(out, 0, 2)).toEqual([2, 1, 42, 255]); // bottom-right → bottom-left
  });

  it('four rotations return to the identity', () => {
    const src = tagged(3, 2);
    const four = rotate90(rotate90(rotate90(rotate90(src))));
    expect([four.width, four.height]).toEqual([3, 2]);
    expect([...four.data]).toEqual([...src.data]);
  });

  it('keeps a square image square', () => {
    const out = rotate90(tagged(4, 4));
    expect([out.width, out.height]).toEqual([4, 4]);
    expect(at(out, 3, 0)).toEqual([0, 0, 42, 255]);
  });
});
