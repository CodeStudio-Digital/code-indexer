/**
 * Conservative edge cleanup for the magic eraser. The flood fill removes the
 * obvious background; this expands only around that mask and only into pixels
 * whose RGB still looks like the removed background/fringe.
 */
import type { Raster } from './image-data.js';

export interface MagicEraserCleanupOptions {
  /** Existing flood tolerance; used to scale the cleanup threshold. */
  tolerance?: number;
  /** Edge expansion radius in pixels. 0 disables cleanup. Default 1. */
  radius?: number;
  /** Optional clip, e.g. active selection. */
  canErase?: (x: number, y: number) => boolean;
}

interface Rgb { r: number; g: number; b: number }

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

function rgbDistance(data: Uint8ClampedArray, i: number, bg: Rgb): number {
  return Math.max(Math.abs(data[i] - bg.r), Math.abs(data[i + 1] - bg.g), Math.abs(data[i + 2] - bg.b));
}

function averageMaskedRgb(raster: Raster, mask: Uint8Array): Rgb | null {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  const d = raster.data;
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue;
    const i = p * 4;
    r += d[i];
    g += d[i + 1];
    b += d[i + 2];
    count++;
  }
  if (count === 0) return null;
  return { r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count) };
}

function touchesMask(mask: Uint8Array, w: number, h: number, x: number, y: number): boolean {
  for (let dy = -1; dy <= 1; dy++) {
    const ny = y + dy;
    if (ny < 0 || ny >= h) continue;
    for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx;
      if (nx < 0 || nx >= w || (dx === 0 && dy === 0)) continue;
      if (mask[ny * w + nx]) return true;
    }
  }
  return false;
}

function subjectSupport(raster: Raster, mask: Uint8Array, bg: Rgb, x: number, y: number, subjectThreshold: number): number {
  const { width: w, height: h, data: d } = raster;
  let count = 0;
  for (let dy = -1; dy <= 1; dy++) {
    const ny = y + dy;
    if (ny < 0 || ny >= h) continue;
    for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx;
      if (nx < 0 || nx >= w || (dx === 0 && dy === 0)) continue;
      const p = ny * w + nx;
      if (mask[p]) continue;
      const i = p * 4;
      if (d[i + 3] === 0) continue;
      if (rgbDistance(d, i, bg) > subjectThreshold) count++;
    }
  }
  return count;
}

export function cleanupMagicEraserMask(
  raster: Raster,
  baseMask: Uint8Array,
  opts: MagicEraserCleanupOptions = {},
): Uint8Array {
  const { width: w, height: h, data: d } = raster;
  const out = new Uint8Array(baseMask);
  if (baseMask.length !== w * h) return out;

  const radius = clamp(Math.floor(opts.radius ?? 1), 0, 3);
  if (radius <= 0) return out;

  const bg = averageMaskedRgb(raster, baseMask);
  if (!bg) return out;

  const tolerance = clamp(opts.tolerance ?? 0, 0, 255);
  const strictThreshold = clamp(Math.round(tolerance * 0.45 + radius * 8), 8, 36);
  const looseThreshold = clamp(Math.round(tolerance + 18 + radius * 10), 24, 96);
  const subjectThreshold = looseThreshold + 16;

  for (let pass = 0; pass < radius; pass++) {
    const toClear: number[] = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (out[p]) continue;
        if (opts.canErase && !opts.canErase(x, y)) continue;
        const i = p * 4;
        if (d[i + 3] === 0) continue;
        if (!touchesMask(out, w, h, x, y)) continue;

        const dist = rgbDistance(d, i, bg);
        if (dist <= strictThreshold) {
          toClear.push(p);
          continue;
        }
        if (dist <= looseThreshold && subjectSupport(raster, out, bg, x, y, subjectThreshold) <= 1) {
          toClear.push(p);
        }
      }
    }
    if (toClear.length === 0) break;
    for (const p of toClear) out[p] = 1;
  }

  return out;
}
