/**
 * Scaling helpers for the pixel-art pipeline. All pure, all deterministic:
 *  - nearestNeighborScale: integer up/downscale for crisp export.
 *  - boxDownscale: alpha-weighted box filter (hi-res AI output → working size).
 *  - pixelSnap: force the image onto a cell grid, dominant color per cell
 *    (fixes AI output that is "almost" pixel art).
 */
import type { Raster } from './image-data.js';
import { createRaster } from './image-data.js';

/** Integer-factor nearest-neighbor scale (sx, sy >= 1, floored). */
export function nearestNeighborScale(src: Raster, sx: number, sy: number = sx): Raster {
  const fx = Math.max(1, Math.floor(sx));
  const fy = Math.max(1, Math.floor(sy));
  const out = createRaster(src.width * fx, src.height * fy);
  for (let y = 0; y < out.height; y++) {
    const srcRow = Math.floor(y / fy) * src.width;
    for (let x = 0; x < out.width; x++) {
      const si = (srcRow + Math.floor(x / fx)) * 4;
      const di = (y * out.width + x) * 4;
      out.data[di] = src.data[si];
      out.data[di + 1] = src.data[si + 1];
      out.data[di + 2] = src.data[si + 2];
      out.data[di + 3] = src.data[si + 3];
    }
  }
  return out;
}

/** Box-filter downscale with alpha-weighted color averaging. */
export function boxDownscale(src: Raster, width: number, height: number): Raster {
  const out = createRaster(width, height);
  const rx = src.width / width;
  const ry = src.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * ry);
    const y1 = Math.max(y0 + 1, Math.min(src.height, Math.round((y + 1) * ry)));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * rx);
      const x1 = Math.max(x0 + 1, Math.min(src.width, Math.round((x + 1) * rx)));
      let r = 0, g = 0, b = 0, aSum = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * src.width + xx) * 4;
          const a = src.data[i + 3];
          r += src.data[i] * a;
          g += src.data[i + 1] * a;
          b += src.data[i + 2] * a;
          aSum += a;
          n++;
        }
      }
      const di = (y * width + x) * 4;
      if (aSum > 0) {
        out.data[di] = Math.round(r / aSum);
        out.data[di + 1] = Math.round(g / aSum);
        out.data[di + 2] = Math.round(b / aSum);
      }
      out.data[di + 3] = Math.round(aSum / n);
    }
  }
  return out;
}

/**
 * Snap to a `cellSize` grid: every cell becomes its dominant color (most
 * frequent RGBA among its pixels; a majority-transparent cell goes fully
 * transparent). Same dimensions as the input. Ties break on the lower packed
 * RGBA value — deterministic.
 */
export function pixelSnap(src: Raster, cellSize: number): Raster {
  const cs = Math.max(1, Math.floor(cellSize));
  const out = createRaster(src.width, src.height);
  const counts = new Map<number, number>();
  for (let cy = 0; cy < src.height; cy += cs) {
    for (let cx = 0; cx < src.width; cx += cs) {
      counts.clear();
      let transparent = 0;
      let total = 0;
      const yEnd = Math.min(src.height, cy + cs);
      const xEnd = Math.min(src.width, cx + cs);
      for (let y = cy; y < yEnd; y++) {
        for (let x = cx; x < xEnd; x++) {
          const i = (y * src.width + x) * 4;
          total++;
          if (src.data[i + 3] < 128) {
            transparent++;
            continue;
          }
          const key = ((src.data[i] << 24) | (src.data[i + 1] << 16) | (src.data[i + 2] << 8) | 255) >>> 0;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
      if (transparent * 2 > total) continue; // majority transparent → leave cell empty
      let bestKey = 0;
      let bestCount = -1;
      for (const [key, n] of counts) {
        if (n > bestCount || (n === bestCount && key < bestKey)) {
          bestKey = key;
          bestCount = n;
        }
      }
      if (bestCount < 0) continue;
      for (let y = cy; y < yEnd; y++) {
        for (let x = cx; x < xEnd; x++) {
          const i = (y * src.width + x) * 4;
          out.data[i] = (bestKey >>> 24) & 0xff;
          out.data[i + 1] = (bestKey >>> 16) & 0xff;
          out.data[i + 2] = (bestKey >>> 8) & 0xff;
          out.data[i + 3] = 255;
        }
      }
    }
  }
  return out;
}
