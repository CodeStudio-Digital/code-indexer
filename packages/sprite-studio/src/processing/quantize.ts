import { buildPaletteSync, utils } from 'image-q';
import { parseHexColor, type RgbColor } from './color.js';
import type { DitherMode, RgbaImage } from './types.js';

export interface QuantizeParams {
  /** Fixed palette as hex strings — takes precedence over maxColors. */
  colors?: string[];
  /** Derive a palette of at most N colors from the image (image-q). */
  maxColors?: number;
  dither?: DitherMode;
}

// Classic 4x4 Bayer matrix, values 0..15.
const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];
const BAYER_SPREAD = 32; // +/-16 threshold offset around each channel

function derivePalette(img: RgbaImage, maxColors: number): RgbColor[] {
  const container = utils.PointContainer.fromUint8Array(img.rgba, img.width, img.height);
  const palette = buildPaletteSync([container], { colors: maxColors });
  const points = palette.getPointContainer().getPointArray();
  const opaque = points.filter((p) => p.a > 0);
  const usable = opaque.length > 0 ? opaque : points;
  return usable.map((p) => ({ r: p.r, g: p.g, b: p.b }));
}

function nearestIndex(palette: RgbColor[], r: number, g: number, b: number): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const dr = r - palette[i].r;
    const dg = g - palette[i].g;
    const db = b - palette[i].b;
    const dist = dr * dr + dg * dg + db * db;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function mapDirect(data: Uint8Array, width: number, height: number, palette: RgbColor[], bayer: boolean): void {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] === 0) continue; // fully transparent: leave untouched
      let r = data[i];
      let g = data[i + 1];
      let b = data[i + 2];
      if (bayer) {
        const t = (BAYER4[y & 3][x & 3] / 16 - 0.5) * BAYER_SPREAD;
        r = clamp255(r + t);
        g = clamp255(g + t);
        b = clamp255(b + t);
      }
      const p = palette[nearestIndex(palette, r, g, b)];
      data[i] = p.r;
      data[i + 1] = p.g;
      data[i + 2] = p.b;
    }
  }
}

/** Serpentine Floyd-Steinberg error diffusion over opaque pixels only. */
function mapFloydSteinberg(data: Uint8Array, width: number, height: number, palette: RgbColor[]): void {
  const err = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const dir = y % 2 === 0 ? 1 : -1;
    const xStart = dir === 1 ? 0 : width - 1;
    for (let step = 0; step < width; step++) {
      const x = xStart + step * dir;
      const idx = y * width + x;
      const i = idx * 4;
      if (data[i + 3] === 0) continue;
      const r = clamp255(data[i] + err[idx * 3]);
      const g = clamp255(data[i + 1] + err[idx * 3 + 1]);
      const b = clamp255(data[i + 2] + err[idx * 3 + 2]);
      const p = palette[nearestIndex(palette, r, g, b)];
      data[i] = p.r;
      data[i + 1] = p.g;
      data[i + 2] = p.b;
      const er = r - p.r;
      const eg = g - p.g;
      const eb = b - p.b;
      const spread = (nx: number, ny: number, w: number) => {
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) return;
        const n = (ny * width + nx) * 3;
        err[n] += er * w;
        err[n + 1] += eg * w;
        err[n + 2] += eb * w;
      };
      spread(x + dir, y, 7 / 16);
      spread(x - dir, y + 1, 3 / 16);
      spread(x, y + 1, 5 / 16);
      spread(x + dir, y + 1, 1 / 16);
    }
  }
}

/**
 * Map every non-transparent pixel to the nearest palette color (RGB
 * euclidean; alpha preserved). Palette comes from `colors` (fixed hex list)
 * or is derived from the image via image-q when only `maxColors` is given.
 */
export function quantizeToPalette(img: RgbaImage, params: QuantizeParams): RgbaImage {
  let palette: RgbColor[];
  if (params.colors && params.colors.length > 0) {
    palette = params.colors.map(parseHexColor);
  } else if (params.maxColors && params.maxColors > 0) {
    palette = derivePalette(img, params.maxColors);
  } else {
    throw new Error('quantizeToPalette requires either colors[] or maxColors');
  }
  const out = new Uint8Array(img.rgba);
  const dither = params.dither ?? 'none';
  if (dither === 'floyd-steinberg') {
    mapFloydSteinberg(out, img.width, img.height, palette);
  } else {
    mapDirect(out, img.width, img.height, palette, dither === 'bayer4');
  }
  return { rgba: out, width: img.width, height: img.height };
}
