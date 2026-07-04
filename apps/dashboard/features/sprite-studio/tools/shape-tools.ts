/**
 * Line / rectangle / ellipse tools — drag-to-define with a LIVE overlay
 * preview (no pixels touched during the drag; the overlay re-runs the same
 * rasterizers, so the preview is pixel-exact) and a single undoable commit on
 * pointer-up. v1 shapes are always HARD (softness/opacity ignored — pixel-art
 * predictability); stroke thickness = brush size via stampAt/stampLine.
 */
import { hexToRgba } from '../algorithms/image-data.js';
import {
  constrain, ellipseFillSpans, ellipseOutlinePoints, rectFillSpans, rectOutlinePoints,
} from '../algorithms/shape-raster.js';
import { tilesForRect } from '../engine/tile-diff.js';
import type { Rect } from '../engine/engine-types.js';
import { stampAt, stampLine } from './brush-tool.js';
import type { Tool, ToolContext, ToolPointerEvent } from './tool-types.js';

type ShapeKind = 'line' | 'rect' | 'ellipse';
const TOOL_ID = { line: 'line', rect: 'shape-rect', ellipse: 'shape-ellipse' } as const;

interface DragState {
  active: boolean;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function endPoint(kind: ShapeKind, s: DragState, e: ToolPointerEvent): { x: number; y: number } {
  const x = Math.floor(e.imageX);
  const y = Math.floor(e.imageY);
  return e.shift ? constrain(kind, s.x0, s.y0, x, y) : { x, y };
}

function publishPreview(kind: ShapeKind, s: DragState, ctx: ToolContext): void {
  ctx.setShapePreview?.({
    kind,
    x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1,
    size: Math.max(1, Math.min(32, Math.floor(ctx.options.size))),
    fill: kind !== 'line' && ctx.options.shapeFill === true,
    color: ctx.colors.fg,
  });
}

/** Fill spans directly (fg, selection-clipped) — no per-pixel stamp overhead. */
function writeSpans(
  img: ImageData,
  spans: Array<{ y: number; x0: number; x1: number }>,
  ctx: ToolContext,
): void {
  const [fr, fg, fb, fa] = hexToRgba(ctx.colors.fg);
  const clip = !ctx.selection.isEmpty();
  for (const s of spans) {
    if (s.y < 0 || s.y >= img.height) continue;
    for (let x = Math.max(0, s.x0); x <= Math.min(img.width - 1, s.x1); x++) {
      if (clip && !ctx.selection.contains(x, s.y)) continue;
      const i = (s.y * img.width + x) * 4;
      img.data[i] = fr;
      img.data[i + 1] = fg;
      img.data[i + 2] = fb;
      img.data[i + 3] = fa;
    }
  }
}

function commit(kind: ShapeKind, s: DragState, ctx: ToolContext): void {
  const layer = ctx.doc.activeLayer;
  if (!layer) return;
  const img = layer.imageData;
  const size = Math.max(1, Math.min(32, Math.floor(ctx.options.size)));
  const pad = Math.ceil(size / 2) + 1;
  const rect: Rect = {
    x: Math.min(s.x0, s.x1) - pad,
    y: Math.min(s.y0, s.y1) - pad,
    w: Math.abs(s.x1 - s.x0) + pad * 2 + 1,
    h: Math.abs(s.y1 - s.y0) + pad * 2 + 1,
  };
  const label = kind === 'line' ? 'Line' : kind === 'rect' ? 'Rectangle' : 'Ellipse';
  ctx.history.beginStroke(layer.id, label);
  ctx.history.touchTiles(img, tilesForRect(rect, img.width, img.height));

  if (kind === 'line') {
    // stampLine re-touches tiles internally (harmless — pristine wins).
    stampLine(s.x0, s.y0, s.x1, s.y1, ctx, false);
  } else if (ctx.options.shapeFill === true) {
    const spans = kind === 'rect'
      ? rectFillSpans(s.x0, s.y0, s.x1, s.y1)
      : ellipseFillSpans(s.x0, s.y0, s.x1, s.y1);
    writeSpans(img, spans, ctx);
  } else {
    const pts = kind === 'rect'
      ? rectOutlinePoints(s.x0, s.y0, s.x1, s.y1)
      : ellipseOutlinePoints(s.x0, s.y0, s.x1, s.y1);
    for (const p of pts) stampAt(img, p.x, p.y, ctx, false);
  }
  ctx.history.endStroke(img);
  ctx.doc.markDirty(rect);
  ctx.invalidate();
}

export function createShapeTool(kind: ShapeKind): Tool {
  const state: DragState = { active: false, x0: 0, y0: 0, x1: 0, y1: 0 };
  return {
    id: TOOL_ID[kind],
    cursor: 'crosshair',
    onDown(e: ToolPointerEvent, ctx: ToolContext) {
      if (!ctx.doc.activeLayer) return;
      state.active = true;
      state.x0 = Math.floor(e.imageX);
      state.y0 = Math.floor(e.imageY);
      state.x1 = state.x0;
      state.y1 = state.y0;
      publishPreview(kind, state, ctx);
    },
    onMove(e: ToolPointerEvent, ctx: ToolContext) {
      if (!state.active || (e.buttons & 1) === 0) return;
      const p = endPoint(kind, state, e);
      if (p.x === state.x1 && p.y === state.y1) return;
      state.x1 = p.x;
      state.y1 = p.y;
      publishPreview(kind, state, ctx);
      ctx.invalidate();
    },
    onUp(e: ToolPointerEvent, ctx: ToolContext) {
      if (!state.active) return;
      state.active = false;
      const p = endPoint(kind, state, e);
      state.x1 = p.x;
      state.y1 = p.y;
      ctx.setShapePreview?.(null);
      commit(kind, state, ctx);
    },
  };
}
