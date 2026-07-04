/**
 * Alpha cleanup for pixel-perfect sprites:
 *  - thresholdAlpha: hard 0/255 alpha (pixelPerfect pipelines require it).
 *  - defringe: bleed the nearest opaque RGB into semi-transparent halo
 *    pixels so downscale/threshold never mixes in background color.
 * Pure — both return new rasters.
 */
import type { Raster } from './image-data.js';
import { cloneRaster } from './image-data.js';

/** Snap every alpha to 0 or 255 at `threshold` (default 128). */
export function thresholdAlpha(raster: Raster, threshold = 128): Raster {
  const out = cloneRaster(raster);
  const d = out.data;
  for (let i = 3; i < d.length; i += 4) d[i] = d[i] >= threshold ? 255 : 0;
  return out;
}

export interface DefringeOptions {
  /** Pixels with alpha >= this are considered "solid" color donors. Default 128. */
  solidAlpha?: number;
  /** Dilation passes — how far the solid RGB bleeds outward. Default 2. */
  passes?: number;
}

/**
 * Replace the RGB of non-solid pixels (halo + transparent ring) with the
 * average RGB of their solid 8-neighbors, iteratively. Alpha is untouched —
 * this only fixes the COLOR under the fading alpha.
 */
export function defringe(raster: Raster, opts: DefringeOptions = {}): Raster {
  const solidAlpha = opts.solidAlpha ?? 128;
  const passes = Math.max(1, opts.passes ?? 2);
  const out = cloneRaster(raster);
  const { width: w, height: h } = out;
  const d = out.data;

  const solid = new Uint8Array(w * h);
  for (let p = 0; p < solid.length; p++) solid[p] = d[p * 4 + 3] >= solidAlpha ? 1 : 0;

  for (let pass = 0; pass < passes; pass++) {
    const promoted: number[] = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (solid[p]) continue;
        let r = 0, g = 0, b = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= w || (dx === 0 && dy === 0)) continue;
            const np = ny * w + nx;
            if (!solid[np]) continue;
            r += d[np * 4];
            g += d[np * 4 + 1];
            b += d[np * 4 + 2];
            n++;
          }
        }
        if (n === 0) continue;
        const i = p * 4;
        d[i] = Math.round(r / n);
        d[i + 1] = Math.round(g / n);
        d[i + 2] = Math.round(b / n);
        promoted.push(p);
      }
    }
    if (promoted.length === 0) break;
    for (const p of promoted) solid[p] = 1; // donors for the next ring
  }
  return out;
}
