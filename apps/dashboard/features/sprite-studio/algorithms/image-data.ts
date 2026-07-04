/**
 * Shared pixel-buffer primitives for the sprite editor algorithms.
 * `Raster` is structurally compatible with the DOM `ImageData`, so every
 * algorithm here runs on real canvas data AND on plain objects (worker/tests)
 * without touching any canvas or DOM API.
 */
export interface Raster {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export type Rgba = [number, number, number, number];

export function createRaster(width: number, height: number): Raster {
  return { data: new Uint8ClampedArray(width * height * 4), width, height };
}

export function cloneRaster(src: Raster): Raster {
  return { data: new Uint8ClampedArray(src.data), width: src.width, height: src.height };
}

/** Read RGBA at (x,y) into `out` — pass a reusable array in hot loops. */
export function getPixel(r: Raster, x: number, y: number, out: Rgba = [0, 0, 0, 0]): Rgba {
  const i = (y * r.width + x) * 4;
  out[0] = r.data[i];
  out[1] = r.data[i + 1];
  out[2] = r.data[i + 2];
  out[3] = r.data[i + 3];
  return out;
}

export function setPixel(r: Raster, x: number, y: number, rgba: Readonly<Rgba>): void {
  const i = (y * r.width + x) * 4;
  r.data[i] = rgba[0];
  r.data[i + 1] = rgba[1];
  r.data[i + 2] = rgba[2];
  r.data[i + 3] = rgba[3];
}

/** Euclidean distance in RGB space (0..~441). */
export function colorDistanceRgb(
  r1: number, g1: number, b1: number,
  r2: number, g2: number, b2: number,
): number {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/** Parse `#rgb`, `#rrggbb` or `#rrggbbaa` (leading `#` optional). */
export function hexToRgba(hex: string): Rgba {
  let h = hex.startsWith('#') ? hex.slice(1) : hex;
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h.length === 6 ? `${h}ff` : h, 16);
  if (Number.isNaN(n) || (h.length !== 6 && h.length !== 8)) return [0, 0, 0, 255];
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

export function rgbaToHex(r: number, g: number, b: number, a = 255): string {
  const to2 = (v: number) => v.toString(16).padStart(2, '0');
  const base = `#${to2(r)}${to2(g)}${to2(b)}`;
  return a >= 255 ? base : `${base}${to2(a)}`;
}

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Bounding box of pixels with alpha >= threshold; null when fully transparent. */
export function alphaBBox(r: Raster, threshold = 1): BBox | null {
  let minX = r.width;
  let minY = r.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      if (r.data[(y * r.width + x) * 4 + 3] >= threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}
