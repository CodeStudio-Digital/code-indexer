/**
 * Palette extraction via median cut over the opaque pixels of a raster.
 * Deterministic on purpose (k-means rejected in the plan): boxes are always
 * split largest-population-first, on their widest channel, at the median.
 * Returns up to `maxColors` hex swatches ordered by population (desc).
 */
import type { Raster } from './image-data.js';
import { rgbaToHex } from './image-data.js';

export interface PaletteExtractOptions {
  /** Number of swatches to aim for. Default 16. */
  maxColors?: number;
  /** Pixels with alpha below this are ignored. Default 128. */
  alphaThreshold?: number;
}

interface Box {
  /** Packed 0xRRGGBB pixels belonging to this box. */
  pixels: number[];
}

const CH_SHIFT = [16, 8, 0] as const;

function channelRange(pixels: number[]): { widest: 0 | 1 | 2; range: number } {
  const min = [255, 255, 255];
  const max = [0, 0, 0];
  for (const p of pixels) {
    for (let c = 0; c < 3; c++) {
      const v = (p >>> CH_SHIFT[c]) & 0xff;
      if (v < min[c]) min[c] = v;
      if (v > max[c]) max[c] = v;
    }
  }
  let widest: 0 | 1 | 2 = 0;
  let range = max[0] - min[0];
  for (const c of [1, 2] as const) {
    const r = max[c] - min[c];
    if (r > range) {
      range = r;
      widest = c;
    }
  }
  return { widest, range };
}

function averageHex(pixels: number[]): string {
  let r = 0;
  let g = 0;
  let b = 0;
  for (const p of pixels) {
    r += (p >>> 16) & 0xff;
    g += (p >>> 8) & 0xff;
    b += p & 0xff;
  }
  const n = pixels.length;
  return rgbaToHex(Math.round(r / n), Math.round(g / n), Math.round(b / n));
}

export function extractPalette(raster: Raster, opts: PaletteExtractOptions = {}): string[] {
  const maxColors = Math.max(1, opts.maxColors ?? 16);
  const alphaThreshold = opts.alphaThreshold ?? 128;
  const { data } = raster;

  const pixels: number[] = [];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] >= alphaThreshold) {
      pixels.push((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
    }
  }
  if (pixels.length === 0) return [];

  const boxes: Box[] = [{ pixels }];
  while (boxes.length < maxColors) {
    // Deterministic pick: most populated box that still has channel spread.
    boxes.sort((a, b) => b.pixels.length - a.pixels.length);
    let target: Box | null = null;
    let widest: 0 | 1 | 2 = 0;
    for (const box of boxes) {
      if (box.pixels.length < 2) continue;
      const cr = channelRange(box.pixels);
      if (cr.range > 0) {
        target = box;
        widest = cr.widest;
        break;
      }
    }
    if (!target) break;

    const shift = CH_SHIFT[widest];
    // Full-value tiebreak keeps the split order-independent and deterministic.
    target.pixels.sort((a, b) => (((a >>> shift) & 0xff) - ((b >>> shift) & 0xff)) || (a - b));
    const mid = target.pixels.length >> 1;
    const right = target.pixels.splice(mid);
    boxes.push({ pixels: right });
  }

  boxes.sort((a, b) => b.pixels.length - a.pixels.length);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const box of boxes) {
    const hex = averageHex(box.pixels);
    if (!seen.has(hex)) {
      seen.add(hex);
      out.push(hex);
    }
  }
  return out;
}
