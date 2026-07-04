/**
 * Auto-crop and re-canvas helpers: trim to the alpha bounding box and place
 * content on a fixed canvas (export presets need centered / bottom-anchored
 * sprites). Pure — return new rasters.
 */
import type { Raster } from './image-data.js';
import { alphaBBox, createRaster } from './image-data.js';

/** Crop to the alpha bbox (+ optional padding). Fully transparent → 1×1 empty. */
export function cropToAlphaBBox(raster: Raster, padding = 0): Raster {
  const box = alphaBBox(raster);
  if (!box) return createRaster(1, 1);
  const x0 = Math.max(0, box.x - padding);
  const y0 = Math.max(0, box.y - padding);
  const x1 = Math.min(raster.width, box.x + box.w + padding);
  const y1 = Math.min(raster.height, box.y + box.h + padding);
  const out = createRaster(x1 - x0, y1 - y0);
  for (let y = 0; y < out.height; y++) {
    const srcStart = ((y0 + y) * raster.width + x0) * 4;
    out.data.set(raster.data.subarray(srcStart, srcStart + out.width * 4), y * out.width * 4);
  }
  return out;
}

export type CanvasAlign = 'center' | 'bottom';

/**
 * Place the alpha-bbox content of `raster` on a w×h canvas: horizontally
 * centered; vertically centered or anchored to the bottom edge. Content
 * larger than the canvas is clipped symmetrically.
 */
export function centerOnCanvas(raster: Raster, w: number, h: number, align: CanvasAlign = 'center'): Raster {
  const content = cropToAlphaBBox(raster);
  const out = createRaster(w, h);
  const dx = Math.floor((w - content.width) / 2);
  const dy = align === 'bottom' ? h - content.height : Math.floor((h - content.height) / 2);
  for (let y = 0; y < content.height; y++) {
    const ty = dy + y;
    if (ty < 0 || ty >= h) continue;
    for (let x = 0; x < content.width; x++) {
      const tx = dx + x;
      if (tx < 0 || tx >= w) continue;
      const si = (y * content.width + x) * 4;
      const di = (ty * w + tx) * 4;
      out.data[di] = content.data[si];
      out.data[di + 1] = content.data[si + 1];
      out.data[di + 2] = content.data[si + 2];
      out.data[di + 3] = content.data[si + 3];
    }
  }
  return out;
}
