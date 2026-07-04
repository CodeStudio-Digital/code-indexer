/**
 * Background removal: flood-fill from all four borders with tolerance, set
 * the matched region to alpha 0, then feather the 1px edge ring by color
 * distance to the average background color (soft anti-halo ramp).
 * Pure — returns a new raster.
 */
import type { Raster } from './image-data.js';
import { cloneRaster } from './image-data.js';
import { floodFillMask } from './flood-fill.js';

export interface BgRemoveOptions {
  /** Chebyshev RGBA tolerance for the border flood. Default 24. */
  tolerance?: number;
  /** Apply the 1px alpha ramp on the edge ring. Default true. */
  feather?: boolean;
}

/** Union of flood fills seeded from every border pixel not yet covered. */
export function borderFloodMask(raster: Raster, tolerance: number): Uint8Array {
  const { width: w, height: h } = raster;
  const mask = new Uint8Array(w * h);
  const seedIfNew = (x: number, y: number) => {
    if (mask[y * w + x]) return;
    const m = floodFillMask(raster, x, y, { tolerance, contiguous: true });
    for (let i = 0; i < mask.length; i++) if (m[i]) mask[i] = 1;
  };
  for (let x = 0; x < w; x++) {
    seedIfNew(x, 0);
    seedIfNew(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    seedIfNew(0, y);
    seedIfNew(w - 1, y);
  }
  return mask;
}

export function removeBackground(raster: Raster, opts: BgRemoveOptions = {}): Raster {
  const tolerance = opts.tolerance ?? 24;
  const out = cloneRaster(raster);
  const { width: w, height: h } = out;
  const d = out.data;
  const mask = borderFloodMask(raster, tolerance);

  // Average background color (used by the feather ramp below).
  let br = 0;
  let bg = 0;
  let bb = 0;
  let count = 0;
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue;
    br += d[p * 4];
    bg += d[p * 4 + 1];
    bb += d[p * 4 + 2];
    count++;
  }
  if (count === 0) return out; // nothing matched — no background found
  br /= count;
  bg /= count;
  bb /= count;

  for (let p = 0; p < mask.length; p++) if (mask[p]) d[p * 4 + 3] = 0;

  if (opts.feather === false) return out;

  // 1px feather: edge pixels (kept pixels touching the removed region) get
  // their alpha scaled by how far their color is from the background — pixels
  // that are basically background-colored fade out, real content stays.
  const rampMax = Math.max(48, tolerance * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (mask[p] || d[p * 4 + 3] === 0) continue;
      const touchesBg =
        (x > 0 && mask[p - 1]) ||
        (x < w - 1 && mask[p + 1]) ||
        (y > 0 && mask[p - w]) ||
        (y < h - 1 && mask[p + w]);
      if (!touchesBg) continue;
      const i = p * 4;
      const dist = Math.max(Math.abs(d[i] - br), Math.abs(d[i + 1] - bg), Math.abs(d[i + 2] - bb));
      const factor = Math.min(1, dist / rampMax);
      d[i + 3] = Math.round(d[i + 3] * factor);
    }
  }
  return out;
}

/** Most frequent border color (coarse 16-level buckets) — the chroma key guess. */
export function dominantBorderColor(raster: Raster): { r: number; g: number; b: number } {
  const { width: w, height: h, data: d } = raster;
  const counts = new Map<number, { n: number; r: number; g: number; b: number }>();
  const tally = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    if (d[i + 3] === 0) return;
    const key = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
    const e = counts.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    e.n++; e.r += d[i]; e.g += d[i + 1]; e.b += d[i + 2];
    counts.set(key, e);
  };
  for (let x = 0; x < w; x++) { tally(x, 0); tally(x, h - 1); }
  for (let y = 1; y < h - 1; y++) { tally(0, y); tally(w - 1, y); }
  let best: { n: number; r: number; g: number; b: number } | null = null;
  for (const e of counts.values()) if (!best || e.n > best.n) best = e;
  if (!best || best.n === 0) return { r: 255, g: 0, b: 255 };
  return { r: Math.round(best.r / best.n), g: Math.round(best.g / best.n), b: Math.round(best.b / best.n) };
}

/**
 * GLOBAL chroma-key sweep: clear EVERY pixel within `tolerance` of the key
 * color, wherever it sits — interior islands, gaps between subjects, JPEG
 * noise the border flood stalls on. Key defaults to the dominant border
 * color. The right tool for solid/keyed backgrounds (the border flood is the
 * conservative option when the background color also appears in the subject).
 */
export function chromaKeyRemove(
  raster: Raster,
  opts: { tolerance?: number; key?: { r: number; g: number; b: number } } = {},
): Raster {
  const tolerance = opts.tolerance ?? 48;
  const key = opts.key ?? dominantBorderColor(raster);
  const out = cloneRaster(raster);
  const d = out.data;
  const tolSq = tolerance * tolerance;
  for (let p = 0; p < out.width * out.height; p++) {
    const i = p * 4;
    if (d[i + 3] === 0) continue;
    const dr = d[i] - key.r;
    const dg = d[i + 1] - key.g;
    const db = d[i + 2] - key.b;
    if (dr * dr + dg * dg + db * db <= tolSq) d[i + 3] = 0;
  }
  return out;
}
