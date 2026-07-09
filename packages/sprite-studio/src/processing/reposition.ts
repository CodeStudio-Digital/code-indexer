import type { RgbaImage } from './types.js';

export interface RepositionSubjectParams {
  dx: number;
  dy: number;
  /** Border/backdrop color tolerance. Default targets white/flat AI backdrops conservatively. */
  backgroundTolerance?: number;
}

interface BBox { minX: number; minY: number; maxX: number; maxY: number }
interface Rgb { r: number; g: number; b: number }

function assertOffset(name: string, value: number): number {
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer, got ${value}`);
  return value;
}

function opaqueBBox(img: RgbaImage): BBox | null {
  let minX = img.width;
  let minY = img.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.rgba[(y * img.width + x) * 4 + 3] === 0) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY };
}

function dominantOpaqueBorderColor(img: RgbaImage, box: BBox): Rgb | null {
  const counts = new Map<number, number>();
  const tally = (x: number, y: number) => {
    const i = (y * img.width + x) * 4;
    if (img.rgba[i + 3] === 0) return;
    const key = (img.rgba[i] << 16) | (img.rgba[i + 1] << 8) | img.rgba[i + 2];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  for (let x = box.minX; x <= box.maxX; x++) {
    tally(x, box.minY);
    if (box.maxY !== box.minY) tally(x, box.maxY);
  }
  for (let y = box.minY + 1; y < box.maxY; y++) {
    tally(box.minX, y);
    if (box.maxX !== box.minX) tally(box.maxX, y);
  }
  let bestKey: number | null = null;
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) { bestKey = key; bestCount = count; }
  }
  return bestKey == null ? null : { r: (bestKey >> 16) & 0xff, g: (bestKey >> 8) & 0xff, b: bestKey & 0xff };
}

function isLikelyLightBackdrop(rgb: Rgb): boolean {
  const max = Math.max(rgb.r, rgb.g, rgb.b);
  const min = Math.min(rgb.r, rgb.g, rgb.b);
  return max >= 160 && max - min <= 40;
}

function colorClose(data: Uint8Array, idx: number, key: Rgb, tolerance: number): boolean {
  const i = idx * 4;
  if (data[i + 3] === 0) return false;
  const dr = data[i] - key.r;
  const dg = data[i + 1] - key.g;
  const db = data[i + 2] - key.b;
  return dr * dr + dg * dg + db * db <= tolerance * tolerance;
}

function clearBorderBackdrop(img: RgbaImage, tolerance: number): RgbaImage {
  const box = opaqueBBox(img);
  if (!box) return { rgba: new Uint8Array(img.rgba), width: img.width, height: img.height };
  const key = dominantOpaqueBorderColor(img, box);
  if (!key || !isLikelyLightBackdrop(key)) {
    return { rgba: new Uint8Array(img.rgba), width: img.width, height: img.height };
  }
  const out = new Uint8Array(img.rgba);
  const visited = new Uint8Array(img.width * img.height);
  const stack: number[] = [];
  const push = (x: number, y: number) => {
    const idx = y * img.width + x;
    if (!visited[idx] && colorClose(out, idx, key, tolerance)) stack.push(idx);
  };
  for (let x = box.minX; x <= box.maxX; x++) {
    push(x, box.minY);
    push(x, box.maxY);
  }
  for (let y = box.minY + 1; y < box.maxY; y++) {
    push(box.minX, y);
    push(box.maxX, y);
  }
  while (stack.length > 0) {
    const idx = stack.pop()!;
    if (visited[idx] || !colorClose(out, idx, key, tolerance)) continue;
    visited[idx] = 1;
    out[idx * 4 + 3] = 0;
    const x = idx % img.width;
    const y = Math.floor(idx / img.width);
    if (x > box.minX) push(x - 1, y);
    if (x < box.maxX) push(x + 1, y);
    if (y > box.minY) push(x, y - 1);
    if (y < box.maxY) push(x, y + 1);
  }
  return { rgba: out, width: img.width, height: img.height };
}

/**
 * Move only the sprite subject inside its existing frame canvas. The output
 * keeps the input width/height; pixels shifted outside the canvas are clipped.
 * Light border-connected backdrops are treated as generation artifacts and
 * cleared before moving so white rectangles do not move with the character.
 */
export function repositionSubjectOnCanvas(img: RgbaImage, params: RepositionSubjectParams): RgbaImage {
  const dx = assertOffset('dx', params.dx);
  const dy = assertOffset('dy', params.dy);
  const tolerance = params.backgroundTolerance ?? 48;
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 255) {
    throw new Error(`backgroundTolerance must be 0-255, got ${tolerance}`);
  }
  const subject = clearBorderBackdrop(img, tolerance);
  const out = new Uint8Array(img.width * img.height * 4);
  for (let y = 0; y < img.height; y++) {
    const ty = y + dy;
    if (ty < 0 || ty >= img.height) continue;
    for (let x = 0; x < img.width; x++) {
      const tx = x + dx;
      if (tx < 0 || tx >= img.width) continue;
      const si = (y * img.width + x) * 4;
      if (subject.rgba[si + 3] === 0) continue;
      const di = (ty * img.width + tx) * 4;
      out[di] = subject.rgba[si];
      out[di + 1] = subject.rgba[si + 1];
      out[di + 2] = subject.rgba[si + 2];
      out[di + 3] = subject.rgba[si + 3];
    }
  }
  return { rgba: out, width: img.width, height: img.height };
}
