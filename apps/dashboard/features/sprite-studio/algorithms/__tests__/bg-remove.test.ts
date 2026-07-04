/**
 * Pure synthetic tests for background removal (no DOM — Raster objects):
 * the global chroma-key sweep vs the border flood, the dominant-border-color
 * auto key and the JPEG-noise tolerance window.
 */
import { describe, expect, it } from 'vitest';
import { createRaster, setPixel, type Raster } from '../image-data.js';
import { chromaKeyRemove, dominantBorderColor, removeBackground } from '../bg-remove.js';

const KEY: [number, number, number, number] = [255, 0, 255, 255]; // magenta
const BLUE: [number, number, number, number] = [0, 0, 255, 255];

const alphaAt = (r: Raster, x: number, y: number) => r.data[(y * r.width + x) * 4 + 3];

/**
 * 8×8 magenta background with a CLOSED blue ring (rows/cols 2..5) and a
 * magenta island inside it — unreachable from the border by flood fill.
 */
function ringRaster(): Raster {
  const r = createRaster(8, 8);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) setPixel(r, x, y, KEY);
  for (let i = 2; i <= 5; i++) {
    setPixel(r, i, 2, BLUE);
    setPixel(r, i, 5, BLUE);
    setPixel(r, 2, i, BLUE);
    setPixel(r, 5, i, BLUE);
  }
  return r; // interior island (3..4, 3..4) stays magenta
}

describe('chromaKeyRemove', () => {
  it('clears interior key-color islands the border flood cannot reach', () => {
    const src = ringRaster();

    const flood = removeBackground(src, { tolerance: 10 });
    expect(alphaAt(flood, 0, 0)).toBe(0); // outside cleared by both
    expect(alphaAt(flood, 3, 3)).toBe(255); // island SURVIVES the flood (the reported bug)

    const chroma = chromaKeyRemove(src, { tolerance: 10 });
    expect(alphaAt(chroma, 0, 0)).toBe(0);
    expect(alphaAt(chroma, 3, 3)).toBe(0); // global sweep clears it
    expect(alphaAt(chroma, 4, 4)).toBe(0);
    expect(alphaAt(chroma, 2, 2)).toBe(255); // subject ring untouched
    expect(alphaAt(src, 0, 0)).toBe(255); // pure — input not mutated
  });

  it('defaults the key to the dominant border color', () => {
    const r = ringRaster();
    expect(dominantBorderColor(r)).toEqual({ r: 255, g: 0, b: 255 });
    const out = chromaKeyRemove(r); // no explicit key
    expect(alphaAt(out, 0, 0)).toBe(0);
    expect(alphaAt(out, 2, 2)).toBe(255);
  });

  it('absorbs JPEG-ish noise at the default tolerance 48 but not at 20', () => {
    const r = ringRaster();
    // Euclidean distance from magenta ≈ √(17²·3) ≈ 29.4 — typical edge noise.
    setPixel(r, 0, 7, [238, 17, 238, 255]);

    const d48 = chromaKeyRemove(r); // default tolerance 48
    expect(alphaAt(d48, 0, 7)).toBe(0);

    const d20 = chromaKeyRemove(r, { tolerance: 20 });
    expect(alphaAt(d20, 0, 7)).toBe(255);
  });

  it('ignores already-transparent pixels and survives an all-transparent raster', () => {
    const empty = createRaster(4, 4);
    expect(dominantBorderColor(empty)).toEqual({ r: 255, g: 0, b: 255 }); // magenta fallback
    const out = chromaKeyRemove(empty);
    expect([...out.data]).toEqual([...empty.data]);
  });

  it('honors an explicit key color', () => {
    const r = createRaster(2, 2);
    setPixel(r, 0, 0, [0, 128, 0, 255]);
    setPixel(r, 1, 0, BLUE);
    setPixel(r, 0, 1, [0, 128, 0, 255]);
    setPixel(r, 1, 1, BLUE);
    const out = chromaKeyRemove(r, { key: { r: 0, g: 128, b: 0 }, tolerance: 4 });
    expect(alphaAt(out, 0, 0)).toBe(0);
    expect(alphaAt(out, 0, 1)).toBe(0);
    expect(alphaAt(out, 1, 0)).toBe(255);
  });
});
