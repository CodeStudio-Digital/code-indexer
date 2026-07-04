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
}

function matches(data: Uint8ClampedArray, i: number, seed: readonly number[], tol: number): boolean {
  const dr = Math.abs(data[i] - seed[0]);
  const dg = Math.abs(data[i + 1] - seed[1]);
  const db = Math.abs(data[i + 2] - seed[2]);
  const da = Math.abs(data[i + 3] - seed[3]);
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

  if (opts.contiguous === false) {
    for (let p = 0; p < w * h; p++) {
      if (matches(data, p * 4, seed, tol)) mask[p] = 1;
    }
    return mask;
  }

  // Scanline fill: pop a point, expand its horizontal span, queue the rows
  // above/below wherever a new span starts.
  const stack: number[] = [sy * w + sx];
  while (stack.length > 0) {
    const p = stack.pop() as number;
    if (mask[p] || !matches(data, p * 4, seed, tol)) continue;
    const y = Math.floor(p / w);
    const rowStart = y * w;
    let x1 = p - rowStart;
    while (x1 > 0 && !mask[rowStart + x1 - 1] && matches(data, (rowStart + x1 - 1) * 4, seed, tol)) x1--;
    let x2 = p - rowStart;
    while (x2 < w - 1 && !mask[rowStart + x2 + 1] && matches(data, (rowStart + x2 + 1) * 4, seed, tol)) x2++;

    let spanUp = false;
    let spanDown = false;
    for (let x = x1; x <= x2; x++) {
      mask[rowStart + x] = 1;
      if (y > 0) {
        const up = rowStart - w + x;
        const hit = !mask[up] && matches(data, up * 4, seed, tol);
        if (hit && !spanUp) {
          stack.push(up);
          spanUp = true;
        } else if (!hit) spanUp = false;
      }
      if (y < h - 1) {
        const down = rowStart + w + x;
        const hit = !mask[down] && matches(data, down * 4, seed, tol);
        if (hit && !spanDown) {
          stack.push(down);
          spanDown = true;
        } else if (!hit) spanDown = false;
      }
    }
  }
  return mask;
}
