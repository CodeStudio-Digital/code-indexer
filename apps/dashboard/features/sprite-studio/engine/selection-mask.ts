/**
 * Uint8 selection mask over the document (1 = selected, null = no selection).
 * Owns the marching-ants Path2D cache: rebuilt ONLY when the selection
 * changes, never in the render loop. `maskToPngBlob` is the one canvas-
 * touching helper (it feeds mask uploads for AI inpaint jobs).
 */
import type { Rect } from './engine-types.js';

export type SelectMode = 'replace' | 'add' | 'subtract';

export class SelectionMask {
  private _width: number;
  private _height: number;
  private mask: Uint8Array | null = null;
  private antsPath: Path2D | null = null;
  private antsDirty = true;
  /** Cached isEmpty() result — isEmpty is called PER PAINTED PIXEL by the
   *  brush/fill clip test and once per rAF tick, so the O(w*h) scan must not
   *  rerun. Invalidated by markChanged() (the single funnel of every mutator);
   *  external code only ever reads `.data`, so the cache cannot go stale. */
  private emptyCache: boolean | null = null;
  onChange: (() => void) | null = null;

  constructor(width: number, height: number) {
    this._width = width;
    this._height = height;
  }

  get width(): number {
    return this._width;
  }

  get height(): number {
    return this._height;
  }

  /** Follow a document resize: the old mask is meaningless — drop it. */
  resize(width: number, height: number): void {
    if (width === this._width && height === this._height) return;
    this._width = width;
    this._height = height;
    this.mask = null;
    this.markChanged();
  }

  get data(): Uint8Array | null {
    return this.mask;
  }

  isEmpty(): boolean {
    if (!this.mask) return true;
    if (this.emptyCache == null) {
      this.emptyCache = true;
      for (let i = 0; i < this.mask.length; i++) {
        if (this.mask[i]) { this.emptyCache = false; break; }
      }
    }
    return this.emptyCache;
  }

  /** Clip test for tools: with no active selection everything is paintable. */
  contains(x: number, y: number): boolean {
    if (!this.mask) return true;
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return false;
    return this.mask[y * this.width + x] !== 0;
  }

  setRect(rect: Rect, mode: SelectMode): void {
    const next = mode === 'replace' || !this.mask ? new Uint8Array(this.width * this.height) : this.mask;
    if (mode !== 'replace' && this.mask) next.set(this.mask);
    const x0 = Math.max(0, Math.floor(rect.x));
    const y0 = Math.max(0, Math.floor(rect.y));
    const x1 = Math.min(this.width, Math.ceil(rect.x + rect.w));
    const y1 = Math.min(this.height, Math.ceil(rect.y + rect.h));
    const value = mode === 'subtract' ? 0 : 1;
    for (let y = y0; y < y1; y++) next.fill(value, y * this.width + x0, y * this.width + x1);
    this.mask = next;
    this.markChanged();
  }

  fromFloodMask(flood: Uint8Array, mode: SelectMode): void {
    const next = mode === 'replace' || !this.mask ? new Uint8Array(this.width * this.height) : new Uint8Array(this.mask);
    for (let i = 0; i < flood.length && i < next.length; i++) {
      if (!flood[i]) continue;
      next[i] = mode === 'subtract' ? 0 : 1;
    }
    this.mask = next;
    this.markChanged();
  }

  translate(dx: number, dy: number): void {
    if (!this.mask) return;
    const next = new Uint8Array(this.width * this.height);
    for (let y = 0; y < this.height; y++) {
      const ny = y + dy;
      if (ny < 0 || ny >= this.height) continue;
      for (let x = 0; x < this.width; x++) {
        if (!this.mask[y * this.width + x]) continue;
        const nx = x + dx;
        if (nx >= 0 && nx < this.width) next[ny * this.width + nx] = 1;
      }
    }
    this.mask = next;
    this.markChanged();
  }

  clear(): void {
    if (!this.mask) return;
    this.mask = null;
    this.markChanged();
  }

  snapshot(): Uint8Array | null {
    return this.mask ? new Uint8Array(this.mask) : null;
  }

  restore(mask: Uint8Array | null): void {
    this.mask = mask ? new Uint8Array(mask) : null;
    this.markChanged();
  }

  bbox(): Rect | null {
    if (!this.mask) return null;
    let minX = this.width, minY = this.height, maxX = -1, maxY = -1;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (!this.mask[y * this.width + x]) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  /** Cached Path2D of the mask boundary in IMAGE coordinates (integer
   *  coords). Rebuilt lazily only after a selection change. */
  marchingAntsPath(): Path2D | null {
    if (!this.mask) return null;
    if (!this.antsDirty && this.antsPath) return this.antsPath;
    const path = new Path2D();
    const m = this.mask;
    const w = this.width;
    const h = this.height;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!m[y * w + x]) continue;
        if (y === 0 || !m[(y - 1) * w + x]) { path.moveTo(x, y); path.lineTo(x + 1, y); }
        if (y === h - 1 || !m[(y + 1) * w + x]) { path.moveTo(x, y + 1); path.lineTo(x + 1, y + 1); }
        if (x === 0 || !m[y * w + x - 1]) { path.moveTo(x, y); path.lineTo(x, y + 1); }
        if (x === w - 1 || !m[y * w + x + 1]) { path.moveTo(x + 1, y); path.lineTo(x + 1, y + 1); }
      }
    }
    this.antsPath = path;
    this.antsDirty = false;
    return path;
  }

  private markChanged(): void {
    this.antsDirty = true;
    this.antsPath = null;
    this.emptyCache = null;
    this.onChange?.();
  }
}

/**
 * Semantic mask equality for history guards: null and all-zero masks are both
 * "no selection". Tools use it to skip pushing no-op selection commands
 * (e.g. click-to-deselect when nothing was selected).
 */
export function masksEqual(a: Uint8Array | null, b: Uint8Array | null): boolean {
  const blankA = !a || a.every((v) => v === 0);
  const blankB = !b || b.every((v) => v === 0);
  if (blankA || blankB) return blankA === blankB;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Render a mask as a black/white PNG (white = selected) for inpaint uploads. */
export async function maskToPngBlob(mask: Uint8Array, width: number, height: number): Promise<Blob> {
  const img = new ImageData(width, height);
  for (let p = 0; p < mask.length; p++) {
    const v = mask[p] ? 255 : 0;
    img.data[p * 4] = v;
    img.data[p * 4 + 1] = v;
    img.data[p * 4 + 2] = v;
    img.data[p * 4 + 3] = 255;
  }
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    (canvas.getContext('2d') as OffscreenCanvasRenderingContext2D).putImageData(img, 0, 0);
    return canvas.convertToBlob({ type: 'image/png' });
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  (canvas.getContext('2d') as CanvasRenderingContext2D).putImageData(img, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
  });
}
