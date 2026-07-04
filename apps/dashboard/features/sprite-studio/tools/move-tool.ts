/**
 * Move tool: on pointer-down the selected pixels (or the whole layer when
 * nothing is selected) are floated to a temp buffer and cleared from a saved
 * layer baseline; every move recomposes baseline + floating at the drag
 * offset; pointer-up restores the baseline, captures pristine history tiles,
 * re-applies the final composite and commits ONE tiles command (plus a
 * selection command when the mask moved with the pixels).
 */
import type { Rect } from '../engine/engine-types.js';
import { tilesForRect } from '../engine/tile-diff.js';
import type { Tool, ToolContext, ToolPointerEvent } from './tool-types.js';

interface MoveState {
  active: boolean;
  startX: number;
  startY: number;
  dx: number;
  dy: number;
  baseline: Uint8ClampedArray | null;
  /** Baseline with the floated pixels cleared out. */
  cleared: Uint8ClampedArray | null;
  hadSelection: boolean;
  maskBefore: Uint8Array | null;
}

const fullRect = (img: ImageData): Rect => ({ x: 0, y: 0, w: img.width, h: img.height });

/** cleared + floating (from baseline) shifted by (dx, dy) → img.data. */
function compose(img: ImageData, state: MoveState, sel: Uint8Array | null): void {
  const { width: w, height: h } = img;
  img.data.set(state.cleared as Uint8ClampedArray);
  const base = state.baseline as Uint8ClampedArray;
  for (let y = 0; y < h; y++) {
    const ty = y + state.dy;
    if (ty < 0 || ty >= h) continue;
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (sel && !sel[p]) continue;
      if (base[p * 4 + 3] === 0) continue;
      const tx = x + state.dx;
      if (tx < 0 || tx >= w) continue;
      const si = p * 4;
      const di = (ty * w + tx) * 4;
      img.data[di] = base[si];
      img.data[di + 1] = base[si + 1];
      img.data[di + 2] = base[si + 2];
      img.data[di + 3] = base[si + 3];
    }
  }
}

export function createMoveTool(): Tool {
  const state: MoveState = {
    active: false, startX: 0, startY: 0, dx: 0, dy: 0,
    baseline: null, cleared: null, hadSelection: false, maskBefore: null,
  };
  return {
    id: 'move',
    cursor: 'move',
    onDown(e: ToolPointerEvent, ctx: ToolContext) {
      const img = ctx.doc.activeLayer?.imageData;
      if (!img) return;
      state.active = true;
      state.startX = Math.floor(e.imageX);
      state.startY = Math.floor(e.imageY);
      state.dx = 0;
      state.dy = 0;
      state.hadSelection = !ctx.selection.isEmpty();
      state.maskBefore = ctx.selection.snapshot();
      state.baseline = new Uint8ClampedArray(img.data);
      state.cleared = new Uint8ClampedArray(img.data);
      const sel = state.hadSelection ? ctx.selection.data : null;
      for (let p = 0; p < img.width * img.height; p++) {
        if (!sel || sel[p]) {
          const i = p * 4;
          state.cleared[i] = 0;
          state.cleared[i + 1] = 0;
          state.cleared[i + 2] = 0;
          state.cleared[i + 3] = 0;
        }
      }
    },
    onMove(e: ToolPointerEvent, ctx: ToolContext) {
      if (!state.active || (e.buttons & 1) === 0) return;
      const dx = Math.floor(e.imageX) - state.startX;
      const dy = Math.floor(e.imageY) - state.startY;
      if (dx === state.dx && dy === state.dy) return;
      state.dx = dx;
      state.dy = dy;
      const img = ctx.doc.activeLayer?.imageData;
      if (!img || !state.baseline) return;
      compose(img, state, state.hadSelection ? state.maskBefore : null);
      ctx.doc.markDirty(fullRect(img)); // move touches source + dest; keep it simple
      ctx.invalidate();
    },
    onUp(_e: ToolPointerEvent, ctx: ToolContext) {
      if (!state.active) return;
      state.active = false;
      const layer = ctx.doc.activeLayer;
      const img = layer?.imageData;
      if (!layer || !img || !state.baseline) return;
      if (state.dx !== 0 || state.dy !== 0) {
        // Restore pristine pixels so history captures a true "before".
        img.data.set(state.baseline);
        ctx.history.beginStroke(layer.id, 'Move');
        ctx.history.touchTiles(img, tilesForRect(fullRect(img), img.width, img.height));
        compose(img, state, state.hadSelection ? state.maskBefore : null);
        ctx.history.endStroke(img);
        if (state.hadSelection) {
          ctx.selection.translate(state.dx, state.dy);
          ctx.history.pushSelection(state.maskBefore, ctx.selection.snapshot(), 'Move selection');
        }
        ctx.doc.markDirty(fullRect(img));
        ctx.invalidate();
      }
      state.baseline = null;
      state.cleared = null;
      state.maskBefore = null;
    },
  };
}
