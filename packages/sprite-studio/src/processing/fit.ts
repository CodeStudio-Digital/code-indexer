/**
 * Framing ops — the difference between "tiny sprite floating in an empty
 * frame" and a production sprite. Image models leave large margins around the
 * subject (and sometimes draw several subjects); downscaling the raw canvas
 * buries the character at ~10px. The generation pipeline therefore always:
 * keepLargestComponent → fitToCanvas(target) after background removal.
 */
import { autoCrop, centerOnCanvas } from './auto-crop.js';
import { boxDownscale, nearestNeighborResize } from './resize.js';
import type { CanvasAlign, RgbaImage } from './types.js';

/**
 * Keep only the largest 4-connected opaque component (alpha > 0), clearing
 * everything else. Defends against "two characters" / sprite-sheet-style
 * outputs when a single subject was requested. No-op when there is nothing
 * opaque.
 */
export function keepLargestComponent(img: RgbaImage): RgbaImage {
  const { width, height, rgba } = img;
  const n = width * height;
  const labels = new Int32Array(n); // 0 = unvisited/transparent
  let bestLabel = 0;
  let bestCount = 0;
  let label = 0;
  const stack: number[] = [];

  for (let start = 0; start < n; start++) {
    if (labels[start] !== 0 || rgba[start * 4 + 3] === 0) continue;
    label++;
    let count = 0;
    stack.push(start);
    labels[start] = label;
    while (stack.length) {
      const idx = stack.pop() as number;
      count++;
      const x = idx % width;
      const y = (idx - x) / width;
      if (x > 0) visit(idx - 1);
      if (x < width - 1) visit(idx + 1);
      if (y > 0) visit(idx - width);
      if (y < height - 1) visit(idx + width);
    }
    if (count > bestCount) {
      bestCount = count;
      bestLabel = label;
    }
  }
  if (bestLabel === 0 || label <= 1) return img; // nothing opaque or single blob

  const out = new Uint8Array(rgba);
  for (let i = 0; i < n; i++) {
    if (labels[i] !== 0 && labels[i] !== bestLabel) out[i * 4 + 3] = 0;
  }
  return { rgba: out, width, height };

  function visit(idx: number): void {
    if (labels[idx] !== 0 || rgba[idx * 4 + 3] === 0) return;
    labels[idx] = label;
    stack.push(idx);
  }
}

export interface FitToCanvasParams {
  width: number;
  height: number;
  /** Empty pixels kept around the subject inside the target. Default 1. */
  margin?: number;
  align?: CanvasAlign;
}

/**
 * Crop to the opaque content, scale it (aspect-preserving) to fill the target
 * minus `margin`, and center it on a transparent target canvas. Box sampling
 * on the way down (hi-res AI output), nearest-neighbor on the way up (tiny
 * content — keeps pixels crisp instead of smearing).
 */
export function fitToCanvas(img: RgbaImage, params: FitToCanvasParams): RgbaImage {
  const margin = Math.max(0, params.margin ?? 1);
  const innerW = Math.max(1, params.width - margin * 2);
  const innerH = Math.max(1, params.height - margin * 2);

  const cropped = autoCrop(img);
  if (cropped.width === 0 || cropped.height === 0) {
    // Fully transparent input — just emit an empty canvas of the target size.
    return { rgba: new Uint8Array(params.width * params.height * 4), width: params.width, height: params.height };
  }
  const scale = Math.min(innerW / cropped.width, innerH / cropped.height);
  const w = Math.max(1, Math.round(cropped.width * scale));
  const h = Math.max(1, Math.round(cropped.height * scale));
  const scaled =
    scale < 1
      ? boxDownscale(cropped, { width: w, height: h })
      : scale > 1
        ? nearestNeighborResize(cropped, { width: w, height: h })
        : cropped;
  return centerOnCanvas(scaled, { width: params.width, height: params.height, align: params.align ?? 'center' });
}
