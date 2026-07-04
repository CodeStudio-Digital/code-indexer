/**
 * Pure synthetic tests for the sprite algorithms (no DOM — Raster objects).
 */
import { describe, expect, it } from 'vitest';
import { createRaster, setPixel, type Raster } from '../image-data.js';
import { floodFillMask } from '../flood-fill.js';
import { mapToPalette } from '../quantize.js';
import { boxDownscale } from '../scale.js';

const RED: [number, number, number, number] = [255, 0, 0, 255];
const BLUE: [number, number, number, number] = [0, 0, 255, 255];

/** 4×4 checker of 2×2 red/blue quadrants. */
function quadRaster(): Raster {
  const r = createRaster(4, 4);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const topLeft = x < 2 && y < 2;
      const bottomRight = x >= 2 && y >= 2;
      setPixel(r, x, y, topLeft || bottomRight ? RED : BLUE);
    }
  }
  return r;
}

describe('floodFillMask', () => {
  it('contiguous fill stops at the color boundary', () => {
    const mask = floodFillMask(quadRaster(), 0, 0, {});
    expect([...mask].reduce((a, b) => a + b, 0)).toBe(4); // top-left quadrant only
    expect(mask[0]).toBe(1);
    expect(mask[1 * 4 + 1]).toBe(1);
    expect(mask[2 * 4 + 2]).toBe(0); // bottom-right red is NOT connected
  });

  it('contiguous=false selects every matching pixel globally', () => {
    const mask = floodFillMask(quadRaster(), 0, 0, { contiguous: false });
    expect([...mask].reduce((a, b) => a + b, 0)).toBe(8); // both red quadrants
    expect(mask[2 * 4 + 2]).toBe(1);
  });

  it('tolerance absorbs near-colors; zero tolerance does not', () => {
    const r = quadRaster();
    setPixel(r, 1, 0, [250, 0, 0, 255]); // slightly-off red inside the quadrant
    expect(floodFillMask(r, 0, 0, {})[1]).toBe(0);
    expect(floodFillMask(r, 0, 0, { tolerance: 10 })[1]).toBe(1);
  });

  it('out-of-bounds seed yields an empty mask', () => {
    const mask = floodFillMask(quadRaster(), -1, 99, {});
    expect([...mask].every((v) => v === 0)).toBe(true);
  });
});

describe('mapToPalette (floyd-steinberg)', () => {
  it('maps every opaque pixel onto the palette, leaves alpha untouched', () => {
    const r = createRaster(4, 4);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) setPixel(r, x, y, [128, 128, 128, 255]);
    setPixel(r, 3, 3, [90, 200, 40, 7]); // semi-transparent odd pixel
    const out = mapToPalette(r, ['#000000', '#ffffff'], { dither: 'floyd-steinberg' });
    let blacks = 0;
    let whites = 0;
    for (let p = 0; p < 16; p++) {
      const i = p * 4;
      const [pr, pg, pb, pa] = [out.data[i], out.data[i + 1], out.data[i + 2], out.data[i + 3]];
      expect(pa).toBe(r.data[i + 3]); // alpha untouched
      if (pa === 0) continue;
      const isBlack = pr === 0 && pg === 0 && pb === 0;
      const isWhite = pr === 255 && pg === 255 && pb === 255;
      expect(isBlack || isWhite).toBe(true);
      if (isBlack) blacks++;
      if (isWhite) whites++;
    }
    // 50% gray on a b/w palette must dither into a MIX, not a flat field.
    expect(blacks).toBeGreaterThan(0);
    expect(whites).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    const make = () => {
      const r = createRaster(3, 3);
      for (let p = 0; p < 9; p++) setPixel(r, p % 3, Math.floor(p / 3), [p * 28, 100, 255 - p * 28, 255]);
      return mapToPalette(r, ['#000000', '#ff0000', '#0000ff', '#ffffff'], { dither: 'floyd-steinberg' });
    };
    expect([...make().data]).toEqual([...make().data]);
  });
});

describe('boxDownscale', () => {
  it('averages a 2×2 block into one pixel (alpha-weighted)', () => {
    const r = createRaster(2, 2);
    setPixel(r, 0, 0, RED);
    setPixel(r, 1, 0, RED);
    setPixel(r, 0, 1, BLUE);
    setPixel(r, 1, 1, BLUE);
    const out = boxDownscale(r, 1, 1);
    expect(out.width).toBe(1);
    expect(out.data[0]).toBe(128); // half red
    expect(out.data[1]).toBe(0);
    expect(out.data[2]).toBe(128); // half blue
    expect(out.data[3]).toBe(255);
  });

  it('transparent pixels do not pollute the color average', () => {
    const r = createRaster(2, 2);
    setPixel(r, 0, 0, RED);
    // other three pixels stay (0,0,0,0)
    const out = boxDownscale(r, 1, 1);
    expect(out.data[0]).toBe(255); // still pure red
    expect(out.data[1]).toBe(0);
    expect(out.data[3]).toBe(64); // 255/4 coverage
  });
});
