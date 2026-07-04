/**
 * Coverage-per-stroke soft painting (Photoshop Opacity semantics). One session
 * per stroke: `begin` snapshots the layer (baseline) and zeroes a Float32
 * coverage map; each stamp raises per-pixel coverage with `max` and recomposes
 * that pixel FROM THE BASELINE — so the dense Bresenham stamps of a single
 * drag never build on each other (no in-stroke saturation), while every NEW
 * stroke re-baselines and therefore accumulates (`1-(1-o)^n`): "repassar
 * escurece". Correct un-premultiplied alpha-over compositing (the old per-
 * channel lerp created dark halos over transparent pixels).
 */
import { hexToRgba } from '../algorithms/image-data.js';

export interface SoftStrokeSession {
  baseline: Uint8ClampedArray;
  coverage: Float32Array;
  width: number;
  height: number;
}

/** Snapshot the layer at stroke start. Call from the tool's onDown. */
export function beginSoftStroke(img: ImageData): SoftStrokeSession {
  return {
    baseline: new Uint8ClampedArray(img.data),
    coverage: new Float32Array(img.width * img.height),
    width: img.width,
    height: img.height,
  };
}

/**
 * PS-style hardness falloff: full weight inside the hard core, smoothstep to
 * zero at the rim. `softness` 0–100 (0 = hard edge, 100 = fully soft).
 * `t` = normalized distance from stamp center (0 center, 1 rim).
 */
export function softWeight(t: number, softness: number): number {
  const h = 1 - Math.max(0, Math.min(100, softness)) / 100; // hard-core radius fraction
  if (t <= h) return 1;
  if (t >= 1) return 0;
  const u = (t - h) / (1 - h);
  return 1 - u * u * (3 - 2 * u); // 1 - smoothstep(u)
}

/**
 * Recompose one pixel from the baseline at the session's current coverage.
 * Paint: alpha-over of fg (alpha = coverage*opacity*fgAlpha) OVER baseline.
 * Erase: baseline alpha scaled down by coverage*opacity.
 */
function composePixel(
  img: ImageData,
  s: SoftStrokeSession,
  p: number,
  fg: readonly number[],
  opacity: number,
  erase: boolean,
): void {
  const i = p * 4;
  const cov = s.coverage[p];
  const baseA = s.baseline[i + 3] / 255;
  if (erase) {
    img.data[i] = s.baseline[i];
    img.data[i + 1] = s.baseline[i + 1];
    img.data[i + 2] = s.baseline[i + 2];
    img.data[i + 3] = Math.round(s.baseline[i + 3] * (1 - cov * opacity));
    return;
  }
  const a = cov * opacity * (fg[3] / 255);
  const outA = a + baseA * (1 - a);
  if (outA <= 0) {
    img.data[i] = s.baseline[i];
    img.data[i + 1] = s.baseline[i + 1];
    img.data[i + 2] = s.baseline[i + 2];
    img.data[i + 3] = 0;
    return;
  }
  for (let c = 0; c < 3; c++) {
    img.data[i + c] = Math.round((fg[c] * a + s.baseline[i + c] * baseA * (1 - a)) / outA);
  }
  img.data[i + 3] = Math.round(outA * 255);
}

export interface SoftStampArgs {
  x: number;
  y: number;
  size: number;
  softness: number;
  /** 0..1 (ToolOptions.opacity / 100). */
  opacity: number;
  fgHex: string;
  erase: boolean;
  /** Selection clip — return true when the pixel is paintable. */
  paintable(px: number, py: number): boolean;
}

/**
 * One soft stamp: raise coverage (max) over a circular footprint and
 * recompose exactly the touched pixels from the baseline. Idempotent for a
 * given coverage state — overlapping stamps inside a stroke never darken.
 */
export function softStampAt(img: ImageData, s: SoftStrokeSession, args: SoftStampArgs): void {
  const size = Math.max(1, Math.min(32, Math.floor(args.size)));
  const half = Math.floor((size - 1) / 2);
  const r = size / 2;
  const fg = hexToRgba(args.fgHex);
  for (let dy = 0; dy < size; dy++) {
    const py = args.y - half + dy;
    if (py < 0 || py >= img.height) continue;
    for (let dx = 0; dx < size; dx++) {
      const px = args.x - half + dx;
      if (px < 0 || px >= img.width) continue;
      const cx = dx - (size - 1) / 2;
      const cy = dy - (size - 1) / 2;
      const dist = Math.sqrt(cx * cx + cy * cy);
      // Soft brushes are always circular — a soft square edge is a contradiction.
      if (size > 2 && dist > r) continue;
      if (!args.paintable(px, py)) continue;
      const t = size === 1 ? 0 : Math.min(1, dist / r);
      const w = softWeight(t, args.softness);
      if (w <= 0) continue;
      const p = py * img.width + px;
      if (w > s.coverage[p]) {
        s.coverage[p] = w;
        composePixel(img, s, p, fg, args.opacity, args.erase);
      }
    }
  }
}
