/**
 * Ordered overlay registry + the built-in overlays. Overlays draw in SCREEN
 * space (the compositor resets the transform before calling them); negative
 * order draws under the layers (checkerboard), positive above (grid, ants,
 * brush ghost). Onion skin (F2) plugs in here without touching the compositor.
 */
import type { SelectionMask } from './selection-mask.js';
import type { Viewport } from './viewport.js';
import type { ShapePreview } from '../tools/tool-types.js';
import {
  ellipseOutlinePoints, linePoints, rectOutlinePoints,
} from '../algorithms/shape-raster.js';

export interface OverlayView {
  viewport: Viewport;
  docW: number;
  docH: number;
  dpr: number;
  canvasW: number;
  canvasH: number;
  selection: SelectionMask;
  /** ms timestamp from the rAF loop (drives the ants dash offset). */
  timeMs: number;
  /** Hover position (image coords) for the brush ghost, or null. */
  brush: {
    x: number; y: number; size: number; shape: 'square' | 'round';
    /** >0 draws the soft radius + hard-core hint. */
    softness: number;
    /** Draw the mirrored footprint across the vertical center axis. */
    mirrorX: boolean;
  } | null;
  /** Live shape-drag preview (line/rect/ellipse tools), or null. */
  shapePreview: ShapePreview | null;
}

export interface Overlay {
  id: string;
  order: number;
  draw(ctx: CanvasRenderingContext2D, view: OverlayView): void;
}

export class OverlayRegistry {
  private overlays: Overlay[] = [];
  /** Ids toggled off (e.g. the pixel grid) — skipped by both draw passes.
   *  Kept separate from registration so a toggle never loses the overlay. */
  private disabledIds = new Set<string>();

  register(overlay: Overlay): void {
    this.unregister(overlay.id);
    this.overlays.push(overlay);
    this.overlays.sort((a, b) => a.order - b.order);
  }

  unregister(id: string): void {
    this.overlays = this.overlays.filter((o) => o.id !== id);
  }

  setEnabled(id: string, enabled: boolean): void {
    if (enabled) this.disabledIds.delete(id);
    else this.disabledIds.add(id);
  }

  isEnabled(id: string): boolean {
    return !this.disabledIds.has(id);
  }

  drawBelow(ctx: CanvasRenderingContext2D, view: OverlayView): void {
    for (const o of this.overlays) if (o.order < 0 && !this.disabledIds.has(o.id)) o.draw(ctx, view);
  }

  drawAbove(ctx: CanvasRenderingContext2D, view: OverlayView): void {
    for (const o of this.overlays) if (o.order >= 0 && !this.disabledIds.has(o.id)) o.draw(ctx, view);
  }
}

/** Transparency checkerboard under the document (8px screen-space squares). */
export function createCheckerboard(): Overlay {
  let pattern: CanvasPattern | null = null;
  return {
    id: 'checkerboard',
    order: -100,
    draw(ctx, view) {
      if (!pattern) {
        const tile = document.createElement('canvas');
        tile.width = 16;
        tile.height = 16;
        const tctx = tile.getContext('2d') as CanvasRenderingContext2D;
        tctx.fillStyle = '#3a3a3a';
        tctx.fillRect(0, 0, 16, 16);
        tctx.fillStyle = '#2a2a2a';
        tctx.fillRect(0, 0, 8, 8);
        tctx.fillRect(8, 8, 8, 8);
        pattern = ctx.createPattern(tile, 'repeat');
      }
      const { viewport, docW, docH } = view;
      const tl = viewport.imageToScreen(0, 0);
      ctx.fillStyle = pattern ?? '#2a2a2a';
      ctx.fillRect(tl.x, tl.y, docW * viewport.zoom, docH * viewport.zoom);
    },
  };
}

/** 1px pixel grid, only at zoom ≥ 8 (below that it would be noise). */
export function createPixelGrid(): Overlay {
  return {
    id: 'pixel-grid',
    order: 10,
    draw(ctx, view) {
      const { viewport, docW, docH, canvasW, canvasH } = view;
      const z = viewport.zoom;
      if (z < 8) return;
      const { panX, panY } = viewport;
      // Only the grid lines inside the doc∩canvas intersection — at high zoom
      // the vast majority of lines are off-screen, and this runs at 60fps
      // whenever the ants overlay keeps the render loop alive. Inline the
      // imageToScreen math to avoid a {x,y} allocation per line.
      const x0 = Math.max(0, Math.floor(-panX / z));
      const x1 = Math.min(docW, Math.ceil((canvasW - panX) / z));
      const y0 = Math.max(0, Math.floor(-panY / z));
      const y1 = Math.min(docH, Math.ceil((canvasH - panY) / z));
      if (x1 < x0 || y1 < y0) return;
      const sx0 = x0 * z + panX;
      const sx1 = x1 * z + panX;
      const sy0 = y0 * z + panY;
      const sy1 = y1 * z + panY;
      ctx.strokeStyle = 'rgba(128,128,128,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = x0; x <= x1; x++) {
        const sx = x * z + panX + 0.5;
        ctx.moveTo(sx, sy0);
        ctx.lineTo(sx, sy1);
      }
      for (let y = y0; y <= y1; y++) {
        const sy = y * z + panY + 0.5;
        ctx.moveTo(sx0, sy);
        ctx.lineTo(sx1, sy);
      }
      ctx.stroke();
    },
  };
}

/** Animated marching ants around the selection (path cached by the mask). */
export function createMarchingAnts(): Overlay {
  return {
    id: 'marching-ants',
    order: 20,
    draw(ctx, view) {
      const path = view.selection.marchingAntsPath();
      if (!path) return;
      const { viewport } = view;
      ctx.save();
      // Path is in image coords — transform it, but keep line width/dash in
      // screen units by dividing by zoom.
      ctx.transform(viewport.zoom, 0, 0, viewport.zoom, viewport.panX, viewport.panY);
      const inv = 1 / viewport.zoom;
      ctx.lineWidth = inv;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.setLineDash([]);
      ctx.stroke(path);
      ctx.strokeStyle = 'rgba(0,0,0,0.9)';
      ctx.setLineDash([4 * inv, 4 * inv]);
      ctx.lineDashOffset = ((view.timeMs / 100) % 8) * inv;
      ctx.stroke(path);
      ctx.restore();
    },
  };
}

/** Brush footprint preview at the hover position (+ soft radius + mirror). */
export function createBrushGhost(): Overlay {
  const drawOne = (ctx: CanvasRenderingContext2D, view: OverlayView, ix: number, iy: number): void => {
    const b = view.brush;
    if (!b) return;
    const { viewport } = view;
    const half = Math.floor((b.size - 1) / 2);
    const s = viewport.imageToScreen(Math.floor(ix) - half, Math.floor(iy) - half);
    const px = b.size * viewport.zoom;
    const soft = b.softness > 0;
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    if (soft || (b.shape === 'round' && b.size > 2)) {
      // Soft brushes are always circular — show the true footprint radius.
      ctx.arc(s.x + px / 2, s.y + px / 2, px / 2, 0, Math.PI * 2);
    } else {
      ctx.rect(s.x + 0.5, s.y + 0.5, px, px);
    }
    ctx.stroke();
    if (soft && px >= 8) {
      // Dashed inner circle at the hard-core radius (PS hardness hint).
      const core = (1 - Math.min(100, b.softness) / 100) * (px / 2);
      if (core >= 2) {
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = 'rgba(255,255,255,0.45)';
        ctx.beginPath();
        ctx.arc(s.x + px / 2, s.y + px / 2, core, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  };
  return {
    id: 'brush-ghost',
    order: 30,
    draw(ctx, view) {
      const b = view.brush;
      if (!b) return;
      drawOne(ctx, view, b.x, b.y);
      if (b.mirrorX) drawOne(ctx, view, view.docW - 1 - Math.floor(b.x), b.y);
    },
  };
}

/** Live shape-drag preview: outline re-runs the SAME rasterizers as the
 *  commit (pixel-exact cells scaled by zoom); fill draws the analytic shape
 *  (interior is solid — approximation invisible, avoids 65k rects/frame). */
export function createShapePreview(): Overlay {
  return {
    id: 'shape-preview',
    order: 25,
    draw(ctx, view) {
      const p = view.shapePreview;
      if (!p) return;
      const { viewport } = view;
      const z = viewport.zoom;
      ctx.save();
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = p.color;
      if (p.fill && p.kind !== 'line') {
        const lo = viewport.imageToScreen(Math.min(p.x0, p.x1), Math.min(p.y0, p.y1));
        const w = (Math.abs(p.x1 - p.x0) + 1) * z;
        const h = (Math.abs(p.y1 - p.y0) + 1) * z;
        ctx.beginPath();
        if (p.kind === 'ellipse') ctx.ellipse(lo.x + w / 2, lo.y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
        else ctx.rect(lo.x, lo.y, w, h);
        ctx.fill();
      } else {
        const pts = p.kind === 'line'
          ? linePoints(p.x0, p.y0, p.x1, p.y1)
          : p.kind === 'rect'
            ? rectOutlinePoints(p.x0, p.y0, p.x1, p.y1)
            : ellipseOutlinePoints(p.x0, p.y0, p.x1, p.y1);
        const half = Math.floor((p.size - 1) / 2);
        const cell = Math.max(1, p.size) * z;
        for (const pt of pts) {
          const s = viewport.imageToScreen(pt.x - half, pt.y - half);
          ctx.fillRect(s.x, s.y, cell, cell);
        }
      }
      ctx.restore();
    },
  };
}
