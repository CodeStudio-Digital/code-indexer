/**
 * 64px tile capture/diff/apply — the storage unit of undo commands. A brush
 * stroke only pays for the tiles it touched (50–300KB) instead of a full
 * document snapshot (4MB at 1024²). Pure: operates on any PixelBuffer.
 */
import type { PixelBuffer, Rect, TilePatch } from './engine-types.js';

export const TILE = 64;

export function tileKey(tx: number, ty: number): string {
  return `${tx}:${ty}`;
}

export function parseTileKey(key: string): [number, number] {
  const i = key.indexOf(':');
  return [Number(key.slice(0, i)), Number(key.slice(i + 1))];
}

/** Tile keys covering `rect`, clipped to the image bounds. */
export function tilesForRect(rect: Rect, width: number, height: number): string[] {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(width - 1, Math.ceil(rect.x + rect.w) - 1);
  const y1 = Math.min(height - 1, Math.ceil(rect.y + rect.h) - 1);
  const keys: string[] = [];
  if (x1 < x0 || y1 < y0) return keys;
  for (let ty = Math.floor(y0 / TILE); ty <= Math.floor(y1 / TILE); ty++) {
    for (let tx = Math.floor(x0 / TILE); tx <= Math.floor(x1 / TILE); tx++) {
      keys.push(tileKey(tx, ty));
    }
  }
  return keys;
}

/** Copy the pixels of each tile out of the image. Keys are sorted so the
 *  capture order (and diffing) is deterministic. */
export function captureTiles(
  img: PixelBuffer,
  tileKeys: Iterable<string>,
): { tiles: TilePatch[]; bytes: number } {
  const keys = [...new Set(tileKeys)].sort();
  const tiles: TilePatch[] = [];
  let bytes = 0;
  for (const key of keys) {
    const [tx, ty] = parseTileKey(key);
    const x = tx * TILE;
    const y = ty * TILE;
    if (x >= img.width || y >= img.height || tx < 0 || ty < 0) continue;
    const w = Math.min(TILE, img.width - x);
    const h = Math.min(TILE, img.height - y);
    const data = new Uint8ClampedArray(w * h * 4);
    for (let row = 0; row < h; row++) {
      const src = ((y + row) * img.width + x) * 4;
      data.set(img.data.subarray(src, src + w * 4), row * w * 4);
    }
    tiles.push({ tx, ty, w, h, data });
    bytes += data.byteLength;
  }
  return { tiles, bytes };
}

function sameData(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Keep only the tiles that actually changed between two same-key captures. */
export function diffTiles(
  before: TilePatch[],
  after: TilePatch[],
): { before: TilePatch[]; after: TilePatch[]; bytes: number } {
  const byKey = new Map<string, TilePatch>();
  for (const t of before) byKey.set(tileKey(t.tx, t.ty), t);
  const keptBefore: TilePatch[] = [];
  const keptAfter: TilePatch[] = [];
  let bytes = 0;
  for (const a of after) {
    const b = byKey.get(tileKey(a.tx, a.ty));
    if (!b || sameData(b.data, a.data)) continue;
    keptBefore.push(b);
    keptAfter.push(a);
    bytes += b.data.byteLength + a.data.byteLength;
  }
  return { before: keptBefore, after: keptAfter, bytes };
}

/** Write tile patches back into the image (undo/redo application). */
export function applyTiles(img: PixelBuffer, tiles: TilePatch[]): void {
  for (const t of tiles) {
    const x = t.tx * TILE;
    const y = t.ty * TILE;
    for (let row = 0; row < t.h; row++) {
      const dst = ((y + row) * img.width + x) * 4;
      img.data.set(t.data.subarray(row * t.w * 4, (row + 1) * t.w * 4), dst);
    }
  }
}
