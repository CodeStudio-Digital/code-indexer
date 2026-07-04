/**
 * Silhouette helpers for character-consistency checks: binary alpha masks and
 * mask IoU (intersection over union) used to compare a candidate against a
 * canonical pose, plus by the diff overlays. Pure.
 */
import type { Raster } from './image-data.js';

/** Binary silhouette: 1 where alpha >= threshold (default 1). */
export function alphaMask(raster: Raster, threshold = 1): Uint8Array {
  const n = raster.width * raster.height;
  const mask = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    if (raster.data[p * 4 + 3] >= threshold) mask[p] = 1;
  }
  return mask;
}

/**
 * Intersection-over-union of two equally sized masks (0..1).
 * Two empty masks are identical → 1. Length mismatch → 0.
 */
export function maskIoU(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return 0;
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] !== 0;
    const bv = b[i] !== 0;
    if (av && bv) inter++;
    if (av || bv) union++;
  }
  return union === 0 ? 1 : inter / union;
}
