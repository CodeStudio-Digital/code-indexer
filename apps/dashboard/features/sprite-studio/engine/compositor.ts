/**
 * Compositor: one offscreen canvas per layer at document resolution, blitted
 * incrementally (only dirty 64px tiles via putImageData with a dirty rect),
 * then drawn to the visible canvas under the viewport transform with
 * imageSmoothingEnabled=false. Overlays draw in screen space around it.
 * Hot path is allocation-free: no objects are created inside render().
 */
import type { EditorDocument } from './document.js';
import type { Layer } from './engine-types.js';
import type { OverlayRegistry, OverlayView } from './overlays.js';
import { parseTileKey, TILE } from './tile-diff.js';

export class Compositor {
  private layerCanvas = new Map<string, HTMLCanvasElement>();
  private layerCtx = new Map<string, CanvasRenderingContext2D>();

  /** Blit the dirty tiles of one layer into its offscreen canvas. */
  syncLayer(layer: Layer, dirtyTiles: Set<string>): void {
    // Self-heal on dimension changes (resize/crop ops, undo across a resize):
    // a cached canvas whose size no longer matches the layer is stale.
    const cached = this.layerCanvas.get(layer.id);
    if (cached && (cached.width !== layer.imageData.width || cached.height !== layer.imageData.height)) {
      this.dropLayer(layer.id);
    }
    let ctx = this.layerCtx.get(layer.id);
    if (!ctx) {
      const canvas = document.createElement('canvas');
      canvas.width = layer.imageData.width;
      canvas.height = layer.imageData.height;
      ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
      this.layerCanvas.set(layer.id, canvas);
      this.layerCtx.set(layer.id, ctx);
    }
    for (const key of dirtyTiles) {
      const [tx, ty] = parseTileKey(key);
      const x = tx * TILE;
      const y = ty * TILE;
      if (x >= layer.imageData.width || y >= layer.imageData.height) continue;
      const w = Math.min(TILE, layer.imageData.width - x);
      const h = Math.min(TILE, layer.imageData.height - y);
      ctx.putImageData(layer.imageData, 0, 0, x, y, w, h);
    }
  }

  /** Consume all dirty tiles from the document into the layer canvases. */
  syncDirty(doc: EditorDocument): void {
    for (const layer of doc.layers) {
      const dirty = doc.takeDirtyTiles(layer.id);
      if (dirty) this.syncLayer(layer, dirty);
    }
  }

  dropLayer(id: string): void {
    this.layerCanvas.delete(id);
    this.layerCtx.delete(id);
  }

  /** Drop canvases for layers that no longer exist in the document. */
  pruneLayers(doc: EditorDocument): void {
    for (const id of this.layerCanvas.keys()) {
      if (!doc.getLayer(id)) this.dropLayer(id);
    }
  }

  /**
   * Full frame: clear → under-overlays (checkerboard) → layers under the
   * zoom/pan transform → over-overlays (grid/ants/ghost) in screen space.
   */
  render(
    ctx: CanvasRenderingContext2D,
    doc: EditorDocument,
    overlays: OverlayRegistry,
    view: OverlayView,
  ): void {
    const { viewport, dpr, canvasW, canvasH } = view;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvasW, canvasH);
    ctx.imageSmoothingEnabled = false;

    overlays.drawBelow(ctx, view);

    ctx.setTransform(
      viewport.zoom * dpr, 0, 0, viewport.zoom * dpr,
      viewport.panX * dpr, viewport.panY * dpr,
    );
    ctx.imageSmoothingEnabled = false;
    for (const layer of doc.layers) {
      if (!layer.visible || layer.opacity <= 0) continue;
      const canvas = this.layerCanvas.get(layer.id);
      if (!canvas) continue;
      ctx.globalAlpha = layer.opacity;
      ctx.drawImage(canvas, 0, 0);
    }
    ctx.globalAlpha = 1;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    overlays.drawAbove(ctx, view);
  }

  dispose(): void {
    this.layerCanvas.clear();
    this.layerCtx.clear();
  }
}
