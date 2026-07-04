import { parseHexColor } from './color.js';
import type { RgbaImage } from './types.js';

export interface OutlineParams {
  color: string;
  thickness: 1 | 2 | 3;
}

/**
 * Draw a solid outline around the sprite: dilate the alpha>0 mask by
 * `thickness` (chebyshev distance, i.e. a square structuring element) and
 * paint `color` at alpha 255 on every dilated pixel that is not part of the
 * sprite itself.
 *
 * The canvas is NOT grown: outline pixels falling outside the bounds are
 * clipped. Callers should pad first (e.g. centerOnCanvas) when the sprite
 * touches an edge.
 */
export function addOutline(img: RgbaImage, params: OutlineParams): RgbaImage {
  const { color, thickness } = params;
  if (thickness !== 1 && thickness !== 2 && thickness !== 3) {
    throw new Error(`Outline thickness must be 1, 2 or 3, got ${String(thickness)}`);
  }
  const { r, g, b } = parseHexColor(color);
  const { width, height, rgba } = img;
  const size = width * height;

  const mask = new Uint8Array(size);
  for (let idx = 0; idx < size; idx++) {
    if (rgba[idx * 4 + 3] > 0) mask[idx] = 1;
  }

  const dilated = new Uint8Array(size);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      const y0 = Math.max(0, y - thickness);
      const y1 = Math.min(height - 1, y + thickness);
      const x0 = Math.max(0, x - thickness);
      const x1 = Math.min(width - 1, x + thickness);
      for (let ny = y0; ny <= y1; ny++) {
        for (let nx = x0; nx <= x1; nx++) {
          dilated[ny * width + nx] = 1;
        }
      }
    }
  }

  const out = new Uint8Array(rgba);
  for (let idx = 0; idx < size; idx++) {
    if (dilated[idx] && !mask[idx]) {
      out[idx * 4] = r;
      out[idx * 4 + 1] = g;
      out[idx * 4 + 2] = b;
      out[idx * 4 + 3] = 255;
    }
  }
  return { rgba: out, width, height };
}
