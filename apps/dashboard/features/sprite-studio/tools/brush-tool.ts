/**
 * Pixel brush + eraser sharing one stamped-line core: Bresenham interpolation
 * between pointer events, square/round stamps (1–32px), hard pixel mode or
 * soft radial-falloff alpha blend. Writes are clipped by the selection mask,
 * capture history tiles BEFORE mutating, and mark dirty tiles after.
 * Shift+click connects a line from the last stamp of the PREVIOUS stroke
 * (same document) — the pixel-art staple.
 */
import { hexToRgba } from '../algorithms/image-data.js';
import { tilesForRect } from '../engine/tile-diff.js';
import type { EditorDocument } from '../engine/document.js';
import type { Rect } from '../engine/engine-types.js';
import type { Tool, ToolContext, ToolPointerEvent } from './tool-types.js';

interface StrokeState {
  lastX: number;
  lastY: number;
  active: boolean;
}

function stampAt(img: ImageData, x: number, y: number, ctx: ToolContext, erase: boolean): void {
  const { options, selection } = ctx;
  const size = Math.max(1, Math.min(32, Math.floor(options.size)));
  const half = Math.floor((size - 1) / 2);
  const round = (options.shape ?? 'square') === 'round' && size > 2;
  const soft = options.softness > 0;
  const [fr, fg, fb, fa] = hexToRgba(ctx.colors.fg);
  const r = size / 2;

  for (let dy = 0; dy < size; dy++) {
    const py = y - half + dy;
    if (py < 0 || py >= img.height) continue;
    for (let dx = 0; dx < size; dx++) {
      const px = x - half + dx;
      if (px < 0 || px >= img.width) continue;
      const cx = dx - (size - 1) / 2;
      const cy = dy - (size - 1) / 2;
      const dist = Math.sqrt(cx * cx + cy * cy);
      if (round && dist > r) continue;
      if (!selection.isEmpty() && !selection.contains(px, py)) continue;
      const i = (py * img.width + px) * 4;
      if (!soft) {
        if (erase) {
          img.data[i + 3] = 0;
        } else {
          img.data[i] = fr;
          img.data[i + 1] = fg;
          img.data[i + 2] = fb;
          img.data[i + 3] = fa;
        }
        continue;
      }
      // Soft mode: radial falloff weight, sharpened by softness.
      const t = size === 1 ? 0 : Math.min(1, dist / r);
      const weight = Math.pow(1 - t, 1 + ctx.options.softness * 3);
      if (erase) {
        img.data[i + 3] = Math.round(img.data[i + 3] * (1 - weight));
      } else {
        const wa = weight * (fa / 255);
        img.data[i] = Math.round(img.data[i] * (1 - wa) + fr * wa);
        img.data[i + 1] = Math.round(img.data[i + 1] * (1 - wa) + fg * wa);
        img.data[i + 2] = Math.round(img.data[i + 2] * (1 - wa) + fb * wa);
        img.data[i + 3] = Math.max(img.data[i + 3], Math.round(255 * wa));
      }
    }
  }
}

/** Stamp along the Bresenham line from (x0,y0) to (x1,y1), inclusive. */
function stampLine(x0: number, y0: number, x1: number, y1: number, ctx: ToolContext, erase: boolean): void {
  const img = ctx.doc.activeLayer?.imageData;
  if (!img) return;
  const size = Math.max(1, Math.min(32, Math.floor(ctx.options.size)));
  const pad = Math.ceil(size / 2) + 1;
  const rect: Rect = {
    x: Math.min(x0, x1) - pad,
    y: Math.min(y0, y1) - pad,
    w: Math.abs(x1 - x0) + pad * 2 + 1,
    h: Math.abs(y1 - y0) + pad * 2 + 1,
  };
  // Pristine tiles first — BEFORE any pixel changes.
  ctx.history.touchTiles(img, tilesForRect(rect, img.width, img.height));

  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  for (;;) {
    stampAt(img, x, y, ctx, erase);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
  ctx.doc.markDirty(rect);
  ctx.invalidate();
}

export function createBrushTool(kind: 'brush' | 'eraser'): Tool {
  const erase = kind === 'eraser';
  const state: StrokeState = { lastX: 0, lastY: 0, active: false };
  /** Last stamp of the PREVIOUS stroke — shift+click draws a line from here.
   *  Tied to the document it was stamped on so it never bleeds across assets. */
  let prev: { x: number; y: number; doc: EditorDocument } | null = null;
  return {
    id: kind,
    cursor: 'crosshair',
    onDown(e: ToolPointerEvent, ctx: ToolContext) {
      const layer = ctx.doc.activeLayer;
      if (!layer) return;
      state.active = true;
      const x = Math.floor(e.imageX);
      const y = Math.floor(e.imageY);
      ctx.history.beginStroke(layer.id, erase ? 'Eraser' : 'Brush');
      // Shift+line: connect from the previous stroke's endpoint as part of
      // THIS stroke (begin/endStroke bracket it → one undo entry). A normal
      // drag afterwards keeps appending to the same stroke, unchanged.
      if (e.shift && prev && prev.doc === ctx.doc) {
        stampLine(prev.x, prev.y, x, y, ctx, erase);
      } else {
        stampLine(x, y, x, y, ctx, erase);
      }
      state.lastX = x;
      state.lastY = y;
    },
    onMove(e: ToolPointerEvent, ctx: ToolContext) {
      if (!state.active || (e.buttons & 1) === 0) return;
      const x = Math.floor(e.imageX);
      const y = Math.floor(e.imageY);
      if (x === state.lastX && y === state.lastY) return;
      stampLine(state.lastX, state.lastY, x, y, ctx, erase);
      state.lastX = x;
      state.lastY = y;
    },
    onUp(_e: ToolPointerEvent, ctx: ToolContext) {
      if (!state.active) return;
      state.active = false;
      prev = { x: state.lastX, y: state.lastY, doc: ctx.doc };
      const img = ctx.doc.activeLayer?.imageData;
      if (img) ctx.history.endStroke(img);
    },
  };
}
