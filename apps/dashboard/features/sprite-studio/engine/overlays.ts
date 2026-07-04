/**
 * Ordered overlay registry + the built-in overlays. Overlays draw in SCREEN
 * space (the compositor resets the transform before calling them); negative
 * order draws under the layers (checkerboard), positive above (grid, ants,
 * brush ghost). Onion skin (F2) plugs in here without touching the compositor.
 */
import type { SelectionMask } from './selection-mask.js';
import type { Viewport } from './viewport.js';

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
  brush: { x: number; y: number; size: number; shape: 'square' | 'round' } | null;
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
      const { viewport, docW, docH } = view;
      if (viewport.zoom < 8) return;
      ctx.strokeStyle = 'rgba(128,128,128,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= docW; x++) {
        const s = viewport.imageToScreen(x, 0);
        ctx.moveTo(s.x + 0.5, s.y);
        ctx.lineTo(s.x + 0.5, s.y + docH * viewport.zoom);
      }
      for (let y = 0; y <= docH; y++) {
        const s = viewport.imageToScreen(0, y);
        ctx.moveTo(s.x, s.y + 0.5);
        ctx.lineTo(s.x + docW * viewport.zoom, s.y + 0.5);
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

/** Brush footprint preview at the hover position. */
export function createBrushGhost(): Overlay {
  return {
    id: 'brush-ghost',
    order: 30,
    draw(ctx, view) {
      const b = view.brush;
      if (!b) return;
      const { viewport } = view;
      const half = Math.floor((b.size - 1) / 2);
      const s = viewport.imageToScreen(Math.floor(b.x) - half, Math.floor(b.y) - half);
      const px = b.size * viewport.zoom;
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (b.shape === 'round' && b.size > 2) {
        ctx.arc(s.x + px / 2, s.y + px / 2, px / 2, 0, Math.PI * 2);
      } else {
        ctx.rect(s.x + 0.5, s.y + 0.5, px, px);
      }
      ctx.stroke();
    },
  };
}
