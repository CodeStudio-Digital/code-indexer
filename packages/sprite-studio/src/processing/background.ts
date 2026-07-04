import { parseHexColor, type RgbColor } from './color.js';
import type { RgbaImage } from './types.js';

export interface RemoveBackgroundParams {
  /** Max RGB euclidean distance (0-255) for a pixel to count as background. */
  tolerance: number;
  /** Explicit background color; defaults to the dominant border color. */
  keyColor?: string;
}

/** Most frequent exact RGB among the border pixels (background heuristic). */
function dominantBorderColor(img: RgbaImage): RgbColor {
  const { rgba, width, height } = img;
  const counts = new Map<number, number>();
  const tally = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    const key = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  for (let x = 0; x < width; x++) {
    tally(x, 0);
    tally(x, height - 1);
  }
  for (let y = 1; y < height - 1; y++) {
    tally(0, y);
    tally(width - 1, y);
  }
  let bestKey = 0;
  let bestCount = -1;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      bestKey = key;
    }
  }
  return { r: (bestKey >> 16) & 0xff, g: (bestKey >> 8) & 0xff, b: bestKey & 0xff };
}

/** Scanline-stack flood fill from all four borders; matched pixels -> alpha 0. */
function floodBordersToTransparent(data: Uint8Array, width: number, height: number, key: RgbColor, tolSq: number): void {
  const visited = new Uint8Array(width * height);
  const canFill = (idx: number): boolean => {
    if (visited[idx]) return false;
    const i = idx * 4;
    const dr = data[i] - key.r;
    const dg = data[i + 1] - key.g;
    const db = data[i + 2] - key.b;
    return dr * dr + dg * dg + db * db <= tolSq;
  };
  const stack: number[] = [];
  for (let x = 0; x < width; x++) {
    if (canFill(x)) stack.push(x);
    const bottom = (height - 1) * width + x;
    if (canFill(bottom)) stack.push(bottom);
  }
  for (let y = 0; y < height; y++) {
    const left = y * width;
    if (canFill(left)) stack.push(left);
    const right = y * width + width - 1;
    if (canFill(right)) stack.push(right);
  }
  while (stack.length > 0) {
    const seed = stack.pop()!;
    if (!canFill(seed)) continue;
    const y = Math.floor(seed / width);
    let x = seed % width;
    while (x > 0 && canFill(y * width + x - 1)) x--;
    let spanAbove = false;
    let spanBelow = false;
    while (x < width && canFill(y * width + x)) {
      const idx = y * width + x;
      visited[idx] = 1;
      data[idx * 4 + 3] = 0;
      if (y > 0) {
        const above = idx - width;
        if (canFill(above)) {
          if (!spanAbove) {
            stack.push(above);
            spanAbove = true;
          }
        } else {
          spanAbove = false;
        }
      }
      if (y < height - 1) {
        const below = idx + width;
        if (canFill(below)) {
          if (!spanBelow) {
            stack.push(below);
            spanBelow = true;
          }
        } else {
          spanBelow = false;
        }
      }
      x++;
    }
  }
}

/**
 * Defringe: bleed the RGB of the nearest fully-opaque pixel into
 * semi-transparent halo pixels (0 < alpha < 255) via BFS. Fully transparent
 * pixels are left untouched.
 */
function defringe(data: Uint8Array, width: number, height: number): void {
  const size = width * height;
  const state = new Uint8Array(size); // 1 = source or already recolored
  const queue: number[] = [];
  for (let idx = 0; idx < size; idx++) {
    if (data[idx * 4 + 3] === 255) {
      state[idx] = 1;
      queue.push(idx);
    }
  }
  let head = 0;
  while (head < queue.length) {
    const idx = queue[head++];
    const x = idx % width;
    const y = Math.floor(idx / width);
    const neighbors = [
      x > 0 ? idx - 1 : -1,
      x < width - 1 ? idx + 1 : -1,
      y > 0 ? idx - width : -1,
      y < height - 1 ? idx + width : -1,
    ];
    for (const n of neighbors) {
      if (n < 0 || state[n] !== 0) continue;
      const a = data[n * 4 + 3];
      if (a === 0 || a === 255) continue;
      data[n * 4] = data[idx * 4];
      data[n * 4 + 1] = data[idx * 4 + 1];
      data[n * 4 + 2] = data[idx * 4 + 2];
      state[n] = 1;
      queue.push(n);
    }
  }
}

/**
 * Remove a flat background: flood fill from all four borders, clearing
 * pixels within `tolerance` of the key color (default: dominant border
 * color) to alpha 0, then defringe semi-transparent halos. Enclosed
 * background-colored regions (not border-connected) are preserved.
 */
export function removeBackground(img: RgbaImage, params: RemoveBackgroundParams): RgbaImage {
  if (!(params.tolerance >= 0) || params.tolerance > 255) {
    throw new Error(`removeBackground tolerance must be 0-255, got ${params.tolerance}`);
  }
  const key = params.keyColor ? parseHexColor(params.keyColor) : dominantBorderColor(img);
  const out = new Uint8Array(img.rgba);
  floodBordersToTransparent(out, img.width, img.height, key, params.tolerance * params.tolerance);
  defringe(out, img.width, img.height);
  return { rgba: out, width: img.width, height: img.height };
}

/**
 * Global chroma-key sweep: clear EVERY pixel within `tolerance` of the key
 * color, wherever it sits. The border flood alone leaves key-colored islands
 * behind (between two subjects, inside enclosed regions) and stalls on JPEG
 * compression noise — for an explicitly reserved key color (#FF00FF flow) a
 * global sweep is the correct semantics: that color simply cannot appear.
 */
export function chromaKeySweep(
  img: RgbaImage,
  params: { keyColor: string; tolerance: number },
): RgbaImage {
  if (!(params.tolerance >= 0) || params.tolerance > 255) {
    throw new Error(`chromaKeySweep tolerance must be 0-255, got ${params.tolerance}`);
  }
  const key = parseHexColor(params.keyColor);
  const tolSq = params.tolerance * params.tolerance;
  const out = new Uint8Array(img.rgba);
  const n = img.width * img.height;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (out[o + 3] === 0) continue;
    const dr = out[o] - key.r;
    const dg = out[o + 1] - key.g;
    const db = out[o + 2] - key.b;
    if (dr * dr + dg * dg + db * db <= tolSq) out[o + 3] = 0;
  }
  defringe(out, img.width, img.height);
  return { rgba: out, width: img.width, height: img.height };
}
