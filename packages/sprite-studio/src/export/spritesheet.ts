/**
 * Grid spritesheet composer — pure function on RgbaImage (worker-friendly,
 * no fs/DOM). Uniform cells (max frame dims), frames centered per cell,
 * optional edge extrusion per cell (anti texture-bleeding) and padding
 * between cells and around the sheet border:
 *
 *   [pad][extrude|cell|extrude][pad][extrude|cell|extrude][pad] ...
 *
 * Reported FrameRects point at the CELL (inside the extrude ring) so
 * engines sample the real pixels, never the duplicated ring.
 */
import type { RgbaImage } from '../processing/types.js';
import type { ComposedSheet, FrameRect } from './atlas-types.js';

export interface ComposeGridParams {
  /** Gap between cells and sheet border, px. Default 0. */
  padding?: number;
  /** Edge-pixel duplication per cell side, px. Default 0. */
  extrude?: number;
  /** Columns; default ceil(sqrt(n)) for a near-square sheet. */
  cols?: number;
}

export interface NamedFrame {
  name: string;
  img: RgbaImage;
}

/**
 * Blit `src` into `dst` as a (cellW+2e)x(cellH+2e) block at (bx,by), with the
 * frame centered in the cell and every block pixel sampled from the cell
 * content clamped to the cell bounds — which IS the edge extrusion (corners
 * included) and a plain copy when e=0.
 */
function blitExtruded(
  dst: RgbaImage,
  src: RgbaImage,
  bx: number,
  by: number,
  cellW: number,
  cellH: number,
  e: number,
): void {
  const offX = Math.floor((cellW - src.width) / 2);
  const offY = Math.floor((cellH - src.height) / 2);
  for (let y = -e; y < cellH + e; y++) {
    const cy = Math.min(cellH - 1, Math.max(0, y));
    for (let x = -e; x < cellW + e; x++) {
      const cx = Math.min(cellW - 1, Math.max(0, x));
      // Cell coordinate → source frame coordinate (transparent margin around).
      const sx = cx - offX;
      const sy = cy - offY;
      if (sx < 0 || sy < 0 || sx >= src.width || sy >= src.height) continue;
      const s = (sy * src.width + sx) * 4;
      const d = ((by + e + y) * dst.width + (bx + e + x)) * 4;
      dst.rgba[d] = src.rgba[s];
      dst.rgba[d + 1] = src.rgba[s + 1];
      dst.rgba[d + 2] = src.rgba[s + 2];
      dst.rgba[d + 3] = src.rgba[s + 3];
    }
  }
}

/** Compose named frames into a uniform-cell grid sheet. */
export function composeGrid(frames: NamedFrame[], params: ComposeGridParams = {}): ComposedSheet {
  if (frames.length === 0) throw new Error('composeGrid needs at least one frame');
  const padding = params.padding ?? 0;
  const extrude = params.extrude ?? 0;
  if (padding < 0 || extrude < 0 || !Number.isInteger(padding) || !Number.isInteger(extrude)) {
    throw new Error(`padding/extrude must be non-negative integers, got ${padding}/${extrude}`);
  }
  const cellW = Math.max(...frames.map((f) => f.img.width));
  const cellH = Math.max(...frames.map((f) => f.img.height));
  const cols = params.cols ?? Math.ceil(Math.sqrt(frames.length));
  if (!Number.isInteger(cols) || cols < 1) throw new Error(`Invalid cols: ${String(params.cols)}`);
  const rows = Math.ceil(frames.length / cols);

  const blockW = cellW + 2 * extrude;
  const blockH = cellH + 2 * extrude;
  const sheetW = padding + cols * (blockW + padding);
  const sheetH = padding + rows * (blockH + padding);

  const sheet: RgbaImage = {
    rgba: new Uint8Array(sheetW * sheetH * 4),
    width: sheetW,
    height: sheetH,
  };
  const rects: FrameRect[] = [];
  for (let i = 0; i < frames.length; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const bx = padding + col * (blockW + padding);
    const by = padding + row * (blockH + padding);
    blitExtruded(sheet, frames[i].img, bx, by, cellW, cellH, extrude);
    rects.push({
      name: frames[i].name,
      x: bx + extrude,
      y: by + extrude,
      w: cellW,
      h: cellH,
      trimmed: false,
      sourceSize: { w: cellW, h: cellH },
      spriteSourceSize: { x: 0, y: 0, w: cellW, h: cellH },
    });
  }
  return { rgba: sheet, rects };
}
