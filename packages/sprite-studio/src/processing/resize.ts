import type { RgbaImage } from './types.js';

export interface ResizeDims {
  width: number;
  height: number;
}

function assertDims(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`Invalid resize dimensions: ${width}x${height}`);
  }
}

/** Point-sampled resize — the pixel-art default for both up and down. */
export function nearestNeighborResize(img: RgbaImage, { width, height }: ResizeDims): RgbaImage {
  assertDims(width, height);
  const out = new Uint8Array(width * height * 4);
  for (let dy = 0; dy < height; dy++) {
    const sy = Math.min(img.height - 1, Math.floor(((dy + 0.5) * img.height) / height));
    for (let dx = 0; dx < width; dx++) {
      const sx = Math.min(img.width - 1, Math.floor(((dx + 0.5) * img.width) / width));
      const s = (sy * img.width + sx) * 4;
      const d = (dy * width + dx) * 4;
      out[d] = img.rgba[s];
      out[d + 1] = img.rgba[s + 1];
      out[d + 2] = img.rgba[s + 2];
      out[d + 3] = img.rgba[s + 3];
    }
  }
  return { rgba: out, width, height };
}

/** Lossless integer upscale (factor 1, 2, 3, ...) — each pixel becomes an NxN block. */
export function integerScale(img: RgbaImage, factor: number): RgbaImage {
  if (!Number.isInteger(factor) || factor < 1) {
    throw new Error(`integerScale factor must be a positive integer, got ${factor}`);
  }
  return nearestNeighborResize(img, { width: img.width * factor, height: img.height * factor });
}

/**
 * Area-average box sampling — the hi-res -> pixel-grid downscale workhorse.
 * RGB is averaged premultiplied by alpha so transparent pixels do not bleed
 * their (meaningless) color into the result.
 */
export function boxDownscale(img: RgbaImage, { width, height }: ResizeDims): RgbaImage {
  assertDims(width, height);
  const { width: sw, height: sh, rgba } = img;
  const out = new Uint8Array(width * height * 4);
  for (let dy = 0; dy < height; dy++) {
    const y0 = (dy * sh) / height;
    const y1 = ((dy + 1) * sh) / height;
    for (let dx = 0; dx < width; dx++) {
      const x0 = (dx * sw) / width;
      const x1 = ((dx + 1) * sw) / width;
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      let aSum = 0;
      let area = 0;
      for (let sy = Math.floor(y0); sy < y1; sy++) {
        const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
        if (wy <= 0) continue;
        for (let sx = Math.floor(x0); sx < x1; sx++) {
          const wx = Math.min(sx + 1, x1) - Math.max(sx, x0);
          if (wx <= 0) continue;
          const w = wx * wy;
          const s = (sy * sw + sx) * 4;
          const a = rgba[s + 3];
          rSum += rgba[s] * a * w;
          gSum += rgba[s + 1] * a * w;
          bSum += rgba[s + 2] * a * w;
          aSum += a * w;
          area += w;
        }
      }
      const d = (dy * width + dx) * 4;
      if (aSum > 0) {
        out[d] = Math.round(rSum / aSum);
        out[d + 1] = Math.round(gSum / aSum);
        out[d + 2] = Math.round(bSum / aSum);
        out[d + 3] = Math.round(aSum / area);
      }
      // else: leave fully transparent black (all zeroes)
    }
  }
  return { rgba: out, width, height };
}
