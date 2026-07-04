/**
 * Pointer tool — the neutral default tool (topmost in the rail, shortcut V).
 * Pure navigation: dragging pans the viewport by screen-space deltas; it
 * never touches pixels, selection or history, so a freshly opened editor can
 * be clicked and dragged without painting by accident. Gesture state lives in
 * a closure like every other tool (one gesture at a time).
 */
import type { Tool, ToolContext, ToolPointerEvent } from './tool-types.js';

interface PointerState {
  active: boolean;
  /** Last screen position (canvas-relative CSS px — pan-invariant). */
  lastX: number;
  lastY: number;
}

export function createPointerTool(): Tool {
  const state: PointerState = { active: false, lastX: 0, lastY: 0 };
  return {
    id: 'pointer',
    cursor: 'default',
    onDown(e: ToolPointerEvent) {
      state.active = true;
      state.lastX = e.screenX;
      state.lastY = e.screenY;
    },
    onMove(e: ToolPointerEvent, ctx: ToolContext) {
      if (!state.active || (e.buttons & 1) === 0) return;
      const dx = e.screenX - state.lastX;
      const dy = e.screenY - state.lastY;
      if (dx === 0 && dy === 0) return;
      state.lastX = e.screenX;
      state.lastY = e.screenY;
      ctx.viewport.panBy(dx, dy);
      ctx.invalidate();
    },
    onUp() {
      state.active = false;
    },
  };
}
