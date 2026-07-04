/**
 * Magic wand: flood mask from the clicked pixel with tolerance + contiguous
 * toggle (both from tool options). shift = add, alt = subtract. One selection
 * command per click.
 */
import { floodFillMask } from '../algorithms/flood-fill.js';
import { masksEqual, type SelectMode } from '../engine/selection-mask.js';
import type { Tool, ToolContext, ToolPointerEvent } from './tool-types.js';

export function createSelectWandTool(): Tool {
  return {
    id: 'select-wand',
    cursor: 'crosshair',
    onDown(e: ToolPointerEvent, ctx: ToolContext) {
      const img = ctx.doc.activeLayer?.imageData;
      if (!img) return;
      const x = Math.floor(e.imageX);
      const y = Math.floor(e.imageY);
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
      const mode: SelectMode = e.shift ? 'add' : e.alt ? 'subtract' : 'replace';
      const before = ctx.selection.snapshot();
      const mask = floodFillMask(img, x, y, {
        tolerance: ctx.options.tolerance,
        contiguous: ctx.options.contiguous,
      });
      ctx.selection.fromFloodMask(mask, mode);
      const after = ctx.selection.snapshot();
      if (!masksEqual(before, after)) {
        ctx.history.pushSelection(before, after, 'Magic wand');
      }
      ctx.invalidate();
    },
    onMove() {},
    onUp() {},
  };
}
