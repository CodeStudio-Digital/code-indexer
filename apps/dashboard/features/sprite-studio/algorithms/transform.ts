/**
 * Pure geometric transforms for the sprite editor: horizontal/vertical flips
 * (same dims) and 90° clockwise rotation (returns swapped dims). Each returns
 * a NEW Raster and never mutates the input, so they slot straight into the
 * AdjustmentsCard `run()` → applyRasterOp pipeline: flips take the same-size
 * snapshot-undo path; rotate90 on non-square images goes through
 * engine.applyResizedActive — both undoable.
 */
import { createRaster, type Raster } from './image-data.js';

/** Mirror across the vertical axis: (x, y) → (w-1-x, y). */
export function flipHorizontal(src: Raster): Raster {
  const { width: w, height: h } = src;
  const out = createRaster(w, h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const si = (row + x) * 4;
      const di = (row + (w - 1 - x)) * 4;
      out.data[di] = src.data[si];
      out.data[di + 1] = src.data[si + 1];
      out.data[di + 2] = src.data[si + 2];
      out.data[di + 3] = src.data[si + 3];
    }
  }
  return out;
}

/** Mirror across the horizontal axis: (x, y) → (x, h-1-y). Row-wise copy. */
export function flipVertical(src: Raster): Raster {
  const { width: w, height: h } = src;
  const out = createRaster(w, h);
  const rowBytes = w * 4;
  for (let y = 0; y < h; y++) {
    const from = (h - 1 - y) * rowBytes;
    out.data.set(src.data.subarray(from, from + rowBytes), y * rowBytes);
  }
  return out;
}

/** Rotate 90° clockwise: (x, y) → (h-1-y, x); output is h×w (dims swapped). */
export function rotate90(src: Raster): Raster {
  const { width: w, height: h } = src;
  const out = createRaster(h, w); // new width = old height
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4;
      const di = (x * h + (h - 1 - y)) * 4;
      out.data[di] = src.data[si];
      out.data[di + 1] = src.data[si + 1];
      out.data[di + 2] = src.data[si + 2];
      out.data[di + 3] = src.data[si + 3];
    }
  }
  return out;
}
