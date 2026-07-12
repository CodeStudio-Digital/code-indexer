import { masksEqual, type SelectMode } from '../engine/selection-mask.js';
import type { Tool, ToolContext, ToolPointerEvent } from './tool-types.js';

interface Point { x: number; y: number }
const inside = (x: number, y: number, points: Point[]): boolean => {
  let hit = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i], b = points[j];
    if (((a.y > y) !== (b.y > y)) && x < ((b.x - a.x) * (y - a.y)) / ((b.y - a.y) || 1e-9) + a.x) hit = !hit;
  }
  return hit;
};

export function createSelectLassoTool(): Tool {
  let points: Point[] = [];
  let mode: SelectMode = 'replace';
  let before: Uint8Array | null = null;
  return {
    id: 'select-lasso', cursor: 'crosshair',
    onDown(event, ctx) {
      points = [{ x: event.imageX, y: event.imageY }];
      mode = event.shift && event.alt ? 'intersect' : event.shift ? 'add' : event.alt ? 'subtract' : 'replace';
      before = ctx.selection.snapshot();
    },
    onMove(event, ctx) {
      if ((event.buttons & 1) === 0 || points.length === 0) return;
      const last = points[points.length - 1];
      if (Math.hypot(event.imageX - last.x, event.imageY - last.y) >= 0.75) points.push({ x: event.imageX, y: event.imageY });
      ctx.invalidate();
    },
    onUp(_event, ctx) {
      if (points.length < 3) { points = []; return; }
      const mask = new Uint8Array(ctx.doc.width * ctx.doc.height);
      const minX = Math.max(0, Math.floor(Math.min(...points.map((p) => p.x))));
      const maxX = Math.min(ctx.doc.width - 1, Math.ceil(Math.max(...points.map((p) => p.x))));
      const minY = Math.max(0, Math.floor(Math.min(...points.map((p) => p.y))));
      const maxY = Math.min(ctx.doc.height - 1, Math.ceil(Math.max(...points.map((p) => p.y))));
      for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
        if (inside(x + 0.5, y + 0.5, points)) mask[y * ctx.doc.width + x] = 1;
      }
      ctx.selection.fromFloodMask(mask, mode);
      const after = ctx.selection.snapshot();
      if (!masksEqual(before, after)) ctx.history.pushSelection(before, after, 'Lasso selection');
      points = []; before = null; ctx.invalidate();
    },
  };
}
