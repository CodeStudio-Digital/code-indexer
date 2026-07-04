/**
 * Palette mapping (quantization) with optional dithering. Pure — returns a
 * new raster; alpha is never touched (transparent pixels are skipped so
 * Floyd–Steinberg error never bleeds through holes in the sprite).
 *
 * Dither modes: 'none', 'floyd-steinberg' (serpentine scan) and ordered
 * Bayer 4×4 / 8×8 (stable, no error propagation — good for animation).
 */
import type { Raster } from './image-data.js';
import { cloneRaster, hexToRgba } from './image-data.js';

export type DitherMode = 'none' | 'floyd-steinberg' | 'bayer4' | 'bayer8';

export interface QuantizeOptions {
  dither?: DitherMode;
  /** Amplitude (in channel units) of the ordered-dither threshold. Default 32. */
  bayerSpread?: number;
}

const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

const BAYER8 = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
];

function parsePalette(paletteHex: string[]): { pr: number[]; pg: number[]; pb: number[] } {
  const pr: number[] = [];
  const pg: number[] = [];
  const pb: number[] = [];
  for (const hex of paletteHex) {
    const [r, g, b] = hexToRgba(hex);
    pr.push(r);
    pg.push(g);
    pb.push(b);
  }
  return { pr, pg, pb };
}

function nearest(r: number, g: number, b: number, pr: number[], pg: number[], pb: number[]): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < pr.length; i++) {
    const dr = r - pr[i];
    const dg = g - pg[i];
    const db = b - pb[i];
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

export function mapToPalette(raster: Raster, paletteHex: string[], opts: QuantizeOptions = {}): Raster {
  const out = cloneRaster(raster);
  if (paletteHex.length === 0) return out;
  const { pr, pg, pb } = parsePalette(paletteHex);
  const { width: w, height: h } = raster;
  const dither = opts.dither ?? 'none';
  const d = out.data;

  if (dither === 'floyd-steinberg') {
    // Float working copy so quantization error accumulates precisely.
    const buf = new Float32Array(d.length);
    for (let i = 0; i < d.length; i++) buf[i] = d[i];
    for (let y = 0; y < h; y++) {
      const ltr = y % 2 === 0; // serpentine scan
      for (let step = 0; step < w; step++) {
        const x = ltr ? step : w - 1 - step;
        const i = (y * w + x) * 4;
        if (d[i + 3] === 0) continue;
        const p = nearest(clamp255(buf[i]), clamp255(buf[i + 1]), clamp255(buf[i + 2]), pr, pg, pb);
        const er = buf[i] - pr[p];
        const eg = buf[i + 1] - pg[p];
        const eb = buf[i + 2] - pb[p];
        d[i] = pr[p];
        d[i + 1] = pg[p];
        d[i + 2] = pb[p];
        const dir = ltr ? 1 : -1;
        const spread = (dx: number, dy: number, wgt: number) => {
          const nx = x + dx * dir;
          const ny = y + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) return;
          const ni = (ny * w + nx) * 4;
          if (d[ni + 3] === 0) return; // never diffuse into transparency
          buf[ni] += er * wgt;
          buf[ni + 1] += eg * wgt;
          buf[ni + 2] += eb * wgt;
        };
        spread(1, 0, 7 / 16);
        spread(-1, 1, 3 / 16);
        spread(0, 1, 5 / 16);
        spread(1, 1, 1 / 16);
      }
    }
    return out;
  }

  const matrix = dither === 'bayer4' ? BAYER4 : dither === 'bayer8' ? BAYER8 : null;
  const n = dither === 'bayer4' ? 4 : 8;
  const spread = opts.bayerSpread ?? 32;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (d[i + 3] === 0) continue;
      let r = d[i];
      let g = d[i + 1];
      let b = d[i + 2];
      if (matrix) {
        const t = ((matrix[y % n][x % n] + 0.5) / (n * n) - 0.5) * spread;
        r = clamp255(r + t);
        g = clamp255(g + t);
        b = clamp255(b + t);
      }
      const p = nearest(r, g, b, pr, pg, pb);
      d[i] = pr[p];
      d[i + 1] = pg[p];
      d[i + 2] = pb[p];
    }
  }
  return out;
}
