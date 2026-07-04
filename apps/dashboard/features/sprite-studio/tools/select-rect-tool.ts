/**
 * Rectangular marquee. shift = add, alt = subtract, plain = replace.
 * The mask is rebuilt live from a baseline snapshot on every drag update and
 * committed as one selection command on pointer-up. A no-drag click clears
 * the selection (replace with an empty rect).
 */
import type { Rect } from '../engine/engine-types.js';
import { masksEqual, type SelectMode } from '../engine/selection-mask.js';
import type { Tool, ToolContext, ToolPointerEvent } from './tool-types.js';

interface DragState {
  active: boolean;
  anchorX: number;
  anchorY: number;
  mode: SelectMode;
  baseline: Uint8Array | null;
}

function dragRect(state: DragState, e: ToolPointerEvent): Rect {
  const x = Math.floor(e.imageX);
  const y = Math.floor(e.imageY);
  return {
    x: Math.min(state.anchorX, x),
    y: Math.min(state.anchorY, y),
    w: Math.abs(x - state.anchorX) + 1,
    h: Math.abs(y - state.anchorY) + 1,
  };
}

export function createSelectRectTool(): Tool {
  const state: DragState = { active: false, anchorX: 0, anchorY: 0, mode: 'replace', baseline: null };
  return {
    id: 'select-rect',
    cursor: 'crosshair',
    onDown(e: ToolPointerEvent, ctx: ToolContext) {
      state.active = true;
      state.anchorX = Math.floor(e.imageX);
      state.anchorY = Math.floor(e.imageY);
      state.mode = e.shift ? 'add' : e.alt ? 'subtract' : 'replace';
      state.baseline = ctx.selection.snapshot();
      if (state.mode === 'replace') ctx.selection.clear();
      ctx.invalidate();
    },
    onMove(e: ToolPointerEvent, ctx: ToolContext) {
      if (!state.active || (e.buttons & 1) === 0) return;
      ctx.selection.restore(state.mode === 'replace' ? null : state.baseline);
      ctx.selection.setRect(dragRect(state, e), state.mode);
      ctx.invalidate();
    },
    onUp(e: ToolPointerEvent, ctx: ToolContext) {
      if (!state.active) return;
      state.active = false;
      const moved = Math.floor(e.imageX) !== state.anchorX || Math.floor(e.imageY) !== state.anchorY;
      if (moved) {
        ctx.selection.restore(state.mode === 'replace' ? null : state.baseline);
        ctx.selection.setRect(dragRect(state, e), state.mode);
      } else if (state.mode === 'replace') {
        ctx.selection.clear(); // plain click deselects
      }
      const after = ctx.selection.snapshot();
      // No-op gestures (click-deselect with nothing selected, re-selecting the
      // same region) must not pollute the undo stack.
      if (!masksEqual(state.baseline, after)) {
        ctx.history.pushSelection(state.baseline, after, 'Select');
      }
      state.baseline = null;
      ctx.invalidate();
    },
  };
}
