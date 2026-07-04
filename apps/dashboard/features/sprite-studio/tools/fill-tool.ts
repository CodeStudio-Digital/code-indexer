/**
 * Paint bucket: flood fill (algorithms/flood-fill) from the clicked pixel,
 * clipped by the selection mask, committed as ONE tiles command.
 */
import { floodFillMask } from '../algorithms/flood-fill.js';
import { hexToRgba } from '../algorithms/image-data.js';
import { tilesForRect } from '../engine/tile-diff.js';
import type { Tool, ToolContext, ToolPointerEvent } from './tool-types.js';

function fillAt(e: ToolPointerEvent, ctx: ToolContext): void {
  const layer = ctx.doc.activeLayer;
  if (!layer) return;
  const img = layer.imageData;
  const x = Math.floor(e.imageX);
  const y = Math.floor(e.imageY);
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  if (!ctx.selection.isEmpty() && !ctx.selection.contains(x, y)) return;

  const mask = floodFillMask(img, x, y, {
    tolerance: ctx.options.tolerance,
    contiguous: ctx.options.contiguous,
  });

  // Bounding box of the filled area (after selection clip) for dirty marking.
  let minX = img.width, minY = img.height, maxX = -1, maxY = -1;
  for (let py = 0; py < img.height; py++) {
    for (let px = 0; px < img.width; px++) {
      const p = py * img.width + px;
      if (!mask[p]) continue;
      if (!ctx.selection.isEmpty() && !ctx.selection.contains(px, py)) {
        mask[p] = 0;
        continue;
      }
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
  }
  if (maxX < 0) return;
  const rect = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };

  ctx.history.beginStroke(layer.id, 'Fill');
  ctx.history.touchTiles(img, tilesForRect(rect, img.width, img.height));
  const [fr, fg, fb, fa] = hexToRgba(ctx.colors.fg);
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue;
    const i = p * 4;
    img.data[i] = fr;
    img.data[i + 1] = fg;
    img.data[i + 2] = fb;
    img.data[i + 3] = fa;
  }
  ctx.history.endStroke(img);
  ctx.doc.markDirty(rect);
  ctx.invalidate();
}

export function createFillTool(): Tool {
  return {
    id: 'fill',
    cursor: 'crosshair',
    onDown: fillAt,
    onMove() {},
    onUp() {},
  };
}
