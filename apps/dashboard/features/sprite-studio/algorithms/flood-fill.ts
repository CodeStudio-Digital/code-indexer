/**
 * Scanline stack flood fill with tolerance. Shared core for the magic wand,
 * paint bucket and background removal. Pure: returns a Uint8Array mask
 * (1 = inside the fill) and never mutates the input raster.
 *
 * Tolerance is Chebyshev over RGBA (max per-channel difference, 0..255) —
 * cheap, deterministic and predictable for pixel art.
 */
import type { Raster } from './image-data.js';

export interface FloodFillOptions {
  /** 0 = exact match, 255 = everything. Default 0. */
  tolerance?: number;
  /** false = select every matching pixel in the image (global). Default true. */
  contiguous?: boolean;
  matchMode?: 'color' | 'alpha';
  colorMetric?: 'channel' | 'perceptual';
}

function linear(v: number): number {
  const n = v / 255;
  return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
}
function lab(r: number, g: number, b: number): readonly [number, number, number] {
  const lr = linear(r), lg = linear(g), lb = linear(b);
  const x = (lr * 0.4124 + lg * 0.3576 + lb * 0.1805) / 0.95047;
  const y = (lr * 0.2126 + lg * 0.7152 + lb * 0.0722);
  const z = (lr * 0.0193 + lg * 0.1192 + lb * 0.9505) / 1.08883;
  const f = (v: number) => v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116;
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function matches(
  data: Uint8ClampedArray, i: number, seed: readonly number[], seedLab: readonly number[],
  tol: number, mode: 'color' | 'alpha', metric: 'channel' | 'perceptual',
): boolean {
  const da = Math.abs(data[i + 3] - seed[3]);
  if (mode === 'alpha') return da <= tol;
  const dr = Math.abs(data[i] - seed[0]);
  const dg = Math.abs(data[i + 1] - seed[1]);
  const db = Math.abs(data[i + 2] - seed[2]);
  if (metric === 'perceptual' && tol > 0) {
    const px = lab(data[i], data[i + 1], data[i + 2]);
    const delta = Math.hypot(px[0] - seedLab[0], px[1] - seedLab[1], px[2] - seedLab[2]);
    return delta <= tol * 0.4 && da <= tol;
  }
  return dr <= tol && dg <= tol && db <= tol && da <= tol;
}

/**
 * Flood fill mask from a seed point. Out-of-bounds seed → empty mask.
 */
export function floodFillMask(
  raster: Raster,
  seedX: number,
  seedY: number,
  opts: FloodFillOptions = {},
): Uint8Array {
  const { width: w, height: h, data } = raster;
  const mask = new Uint8Array(w * h);
  const sx = Math.floor(seedX);
  const sy = Math.floor(seedY);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return mask;

  const tol = Math.max(0, Math.min(255, opts.tolerance ?? 0));
  const si = (sy * w + sx) * 4;
  const seed = [data[si], data[si + 1], data[si + 2], data[si + 3]] as const;
  const seedLab = lab(seed[0], seed[1], seed[2]);
  const mode = opts.matchMode ?? 'color';
  const metric = opts.colorMetric ?? 'channel';

  if (opts.contiguous === false) {
    for (let p = 0; p < w * h; p++) {
      if (matches(data, p * 4, seed, seedLab, tol, mode, metric)) mask[p] = 1;
    }
    return mask;
  }

  // Scanline fill: pop a point, expand its horizontal span, queue the rows
  // above/below wherever a new span starts.
  const stack: number[] = [sy * w + sx];
  while (stack.length > 0) {
    const p = stack.pop() as number;
    if (mask[p] || !matches(data, p * 4, seed, seedLab, tol, mode, metric)) continue;
    const y = Math.floor(p / w);
    const rowStart = y * w;
    let x1 = p - rowStart;
    while (x1 > 0 && !mask[rowStart + x1 - 1] && matches(data, (rowStart + x1 - 1) * 4, seed, seedLab, tol, mode, metric)) x1--;
    let x2 = p - rowStart;
    while (x2 < w - 1 && !mask[rowStart + x2 + 1] && matches(data, (rowStart + x2 + 1) * 4, seed, seedLab, tol, mode, metric)) x2++;

    let spanUp = false;
    let spanDown = false;
    for (let x = x1; x <= x2; x++) {
      mask[rowStart + x] = 1;
      if (y > 0) {
        const up = rowStart - w + x;
        const hit = !mask[up] && matches(data, up * 4, seed, seedLab, tol, mode, metric);
        if (hit && !spanUp) {
          stack.push(up);
          spanUp = true;
        } else if (!hit) spanUp = false;
      }
      if (y < h - 1) {
        const down = rowStart + w + x;
        const hit = !mask[down] && matches(data, down * 4, seed, seedLab, tol, mode, metric);
        if (hit && !spanDown) {
          stack.push(down);
          spanDown = true;
        } else if (!hit) spanDown = false;
      }
    }
  }
  return mask;
}
