/**
 * Sprite outline: Chebyshev dilation of the alpha mask into transparent
 * pixels, painted with a solid stroke color (thickness 1–3). Plus a
 * `removeHalo` helper that strips semi-transparent fringe pixels left by
 * AI-generated edges. Both pure — return new rasters.
 */
import type { Raster } from './image-data.js';
import { cloneRaster, hexToRgba } from './image-data.js';

export interface OutlineOptions {
  colorHex: string;
  /** Stroke thickness in pixels (1–3). Default 1. */
  thickness?: number;
}

export function addOutline(raster: Raster, opts: OutlineOptions): Raster {
  const t = Math.max(1, Math.min(3, Math.floor(opts.thickness ?? 1)));
  const [cr, cg, cb] = hexToRgba(opts.colorHex);
  const out = cloneRaster(raster);
  const { width: w, height: h } = out;
  const d = out.data;

  // Opaque mask from the ORIGINAL raster so painted outline pixels never
  // cascade into further dilation.
  const solid = new Uint8Array(w * h);
  for (let p = 0; p < solid.length; p++) solid[p] = raster.data[p * 4 + 3] >= 128 ? 1 : 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (solid[p]) continue;
      // Chebyshev distance <= t → any opaque pixel in the (2t+1)² window.
      let hit = false;
      for (let dy = -t; dy <= t && !hit; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -t; dx <= t; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          if (solid[ny * w + nx]) {
            hit = true;
            break;
          }
        }
      }
      if (hit) {
        const i = p * 4;
        d[i] = cr;
        d[i + 1] = cg;
        d[i + 2] = cb;
        d[i + 3] = 255;
      }
    }
  }
  return out;
}

export interface RemoveHaloOptions {
  /** Edge pixels with alpha below this are cleared. Default 128. */
  maxAlpha?: number;
  /** How many erosion passes to run (halo rings can be 2px). Default 2. */
  passes?: number;
}

/** Strip the semi-transparent fringe ring around the sprite silhouette. */
export function removeHalo(raster: Raster, opts: RemoveHaloOptions = {}): Raster {
  const maxAlpha = opts.maxAlpha ?? 128;
  const passes = Math.max(1, opts.passes ?? 2);
  const out = cloneRaster(raster);
  const { width: w, height: h } = out;
  const d = out.data;

  for (let pass = 0; pass < passes; pass++) {
    const toClear: number[] = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        const a = d[p * 4 + 3];
        if (a === 0 || a >= maxAlpha) continue;
        const touchesVoid =
          x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
          d[(p - 1) * 4 + 3] === 0 ||
          d[(p + 1) * 4 + 3] === 0 ||
          d[(p - w) * 4 + 3] === 0 ||
          d[(p + w) * 4 + 3] === 0;
        if (touchesVoid) toClear.push(p);
      }
    }
    if (toClear.length === 0) break;
    for (const p of toClear) d[p * 4 + 3] = 0;
  }
  return out;
}
