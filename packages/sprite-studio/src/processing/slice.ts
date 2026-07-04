/**
 * Grid slicing — the local half of frame-pack prompting: ask the model for ONE
 * image containing a cols×rows grid of variants (or animation frames, F2) and
 * cut it into equal cells here. 4 sprites for the price of 1 image. Cells are
 * cleaned downstream by keepLargestComponent + fitToCanvas, so imperfect grid
 * alignment from the model is tolerated.
 */
import type { RgbaImage } from './types.js';

/** Cut an image into cols×rows equal cells (row-major order). */
export function sliceGrid(img: RgbaImage, cols: number, rows: number): RgbaImage[] {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
    throw new Error(`sliceGrid: invalid grid ${cols}x${rows}`);
  }
  const cellW = Math.floor(img.width / cols);
  const cellH = Math.floor(img.height / rows);
  if (cellW < 1 || cellH < 1) {
    throw new Error(`sliceGrid: image ${img.width}x${img.height} too small for ${cols}x${rows}`);
  }
  const cells: RgbaImage[] = [];
  for (let ry = 0; ry < rows; ry++) {
    for (let cx = 0; cx < cols; cx++) {
      const rgba = new Uint8Array(cellW * cellH * 4);
      const srcX = cx * cellW;
      const srcY = ry * cellH;
      for (let y = 0; y < cellH; y++) {
        const srcOff = ((srcY + y) * img.width + srcX) * 4;
        rgba.set(img.rgba.subarray(srcOff, srcOff + cellW * 4), y * cellW * 4);
      }
      cells.push({ rgba, width: cellW, height: cellH });
    }
  }
  return cells;
}

/** Grid layout for n packed variants: 2→2x1, 3→3x1, 4→2x2, 6→3x2, 8→4x2. */
export function gridFor(n: number): { cols: number; rows: number } {
  if (n <= 1) return { cols: 1, rows: 1 };
  if (n <= 3) return { cols: n, rows: 1 };
  if (n === 4) return { cols: 2, rows: 2 };
  if (n <= 6) return { cols: 3, rows: 2 };
  return { cols: 4, rows: Math.ceil(n / 4) };
}

export interface SliceOpts {
  cols: number;
  rows: number;
  /** Left/top pixels skipped before the first cell (grid shift). */
  offsetX?: number;
  offsetY?: number;
  /** Right/bottom pixels trimmed off the usable area. */
  marginX?: number;
  marginY?: number;
}

/**
 * Custom re-slice of an original sheet: the usable region is
 * `[offsetX, offsetY]` → `[width-marginX, height-marginY]`, divided into
 * cols×rows equal cells (row-major). Recovers clean frames when the model's
 * grid is off-center or padded. Falls back to the plain equal grid at 0/0.
 */
export function sliceGridAdvanced(img: RgbaImage, o: SliceOpts): RgbaImage[] {
  const cols = Math.max(1, Math.floor(o.cols));
  const rows = Math.max(1, Math.floor(o.rows));
  const ox = Math.max(0, Math.floor(o.offsetX ?? 0));
  const oy = Math.max(0, Math.floor(o.offsetY ?? 0));
  const usableW = img.width - ox - Math.max(0, Math.floor(o.marginX ?? 0));
  const usableH = img.height - oy - Math.max(0, Math.floor(o.marginY ?? 0));
  const cellW = Math.floor(usableW / cols);
  const cellH = Math.floor(usableH / rows);
  if (cellW < 1 || cellH < 1) {
    throw new Error(`sliceGridAdvanced: usable area ${usableW}x${usableH} too small for ${cols}x${rows}`);
  }
  const cells: RgbaImage[] = [];
  for (let ry = 0; ry < rows; ry++) {
    for (let cx = 0; cx < cols; cx++) {
      const rgba = new Uint8Array(cellW * cellH * 4);
      const srcX = ox + cx * cellW;
      const srcY = oy + ry * cellH;
      for (let y = 0; y < cellH; y++) {
        const srcOff = ((srcY + y) * img.width + srcX) * 4;
        rgba.set(img.rgba.subarray(srcOff, srcOff + cellW * 4), y * cellW * 4);
      }
      cells.push({ rgba, width: cellW, height: cellH });
    }
  }
  return cells;
}
