/**
 * EditorDocument — ordered ImageData layers + the dirty-tile bookkeeping that
 * drives incremental compositor blits. `layer.imageData` is the source of
 * truth for pixels; everything else derives from it. No React, no rendering.
 */
import type { DocSnapshot, Layer, Rect } from './engine-types.js';
import { tilesForRect } from './tile-diff.js';

let nextLayerId = 1;

export class EditorDocument {
  private _width: number;
  private _height: number;
  layers: Layer[] = [];
  activeLayerId: string | null = null;
  /** Consumed by the compositor every frame: layerId → dirty tile keys. */
  private dirtyByLayer = new Map<string, Set<string>>();

  constructor(width: number, height: number) {
    this._width = width;
    this._height = height;
  }

  get width(): number {
    return this._width;
  }

  get height(): number {
    return this._height;
  }

  /**
   * Change the document dimensions (resize/crop ops). Callers own replacing
   * the layer pixels to match — this only fixes the coordinate space so
   * dirty-tile bookkeeping, flatten() and snapshots stay coherent.
   */
  resizeTo(width: number, height: number): void {
    this._width = width;
    this._height = height;
    this.dirtyByLayer.clear();
  }

  get activeLayer(): Layer | null {
    return this.layers.find((l) => l.id === this.activeLayerId) ?? null;
  }

  getLayer(id: string): Layer | null {
    return this.layers.find((l) => l.id === id) ?? null;
  }

  addLayer(name?: string, imageData?: ImageData): Layer {
    const layer: Layer = {
      id: `layer-${nextLayerId++}`,
      name: name ?? `Layer ${this.layers.length + 1}`,
      visible: true,
      opacity: 1,
      imageData: imageData ?? new ImageData(this.width, this.height),
    };
    this.layers.push(layer);
    this.activeLayerId = layer.id;
    this.markAllDirty(layer.id);
    return layer;
  }

  removeLayer(id: string): void {
    const i = this.layers.findIndex((l) => l.id === id);
    if (i < 0) return;
    this.layers.splice(i, 1);
    this.dirtyByLayer.delete(id);
    if (this.activeLayerId === id) this.activeLayerId = this.layers[Math.min(i, this.layers.length - 1)]?.id ?? null;
  }

  reorderLayer(id: string, toIndex: number): void {
    const i = this.layers.findIndex((l) => l.id === id);
    if (i < 0) return;
    const [layer] = this.layers.splice(i, 1);
    this.layers.splice(Math.max(0, Math.min(this.layers.length, toIndex)), 0, layer);
  }

  setOpacity(id: string, opacity: number): void {
    const l = this.getLayer(id);
    if (l) l.opacity = Math.max(0, Math.min(1, opacity));
  }

  setVisible(id: string, visible: boolean): void {
    const l = this.getLayer(id);
    if (l) l.visible = visible;
  }

  /** Mark a document-space rect dirty on a layer (default: active layer). */
  markDirty(rect: Rect, layerId = this.activeLayerId): void {
    if (!layerId) return;
    let set = this.dirtyByLayer.get(layerId);
    if (!set) {
      set = new Set();
      this.dirtyByLayer.set(layerId, set);
    }
    for (const key of tilesForRect(rect, this.width, this.height)) set.add(key);
  }

  markAllDirty(layerId?: string): void {
    const rect: Rect = { x: 0, y: 0, w: this.width, h: this.height };
    if (layerId) this.markDirty(rect, layerId);
    else for (const l of this.layers) this.markDirty(rect, l.id);
  }

  hasDirty(): boolean {
    for (const set of this.dirtyByLayer.values()) if (set.size > 0) return true;
    return false;
  }

  /** Hand the dirty tiles of a layer to the compositor (consumes them). */
  takeDirtyTiles(layerId: string): Set<string> | null {
    const set = this.dirtyByLayer.get(layerId);
    if (!set || set.size === 0) return null;
    this.dirtyByLayer.delete(layerId);
    return set;
  }

  /** Software composite of the visible layers (source-over, straight alpha). */
  flatten(): ImageData {
    const out = new ImageData(this.width, this.height);
    const d = out.data;
    for (const layer of this.layers) {
      if (!layer.visible || layer.opacity <= 0) continue;
      const s = layer.imageData.data;
      const op = layer.opacity;
      for (let i = 0; i < d.length; i += 4) {
        const sa = (s[i + 3] / 255) * op;
        if (sa <= 0) continue;
        const da = d[i + 3] / 255;
        const oa = sa + da * (1 - sa);
        if (oa <= 0) continue;
        d[i] = Math.round((s[i] * sa + d[i] * da * (1 - sa)) / oa);
        d[i + 1] = Math.round((s[i + 1] * sa + d[i + 1] * da * (1 - sa)) / oa);
        d[i + 2] = Math.round((s[i + 2] * sa + d[i + 2] * da * (1 - sa)) / oa);
        d[i + 3] = Math.round(oa * 255);
      }
    }
    return out;
  }

  snapshot(): DocSnapshot {
    return {
      width: this.width,
      height: this.height,
      activeLayerId: this.activeLayerId,
      layers: this.layers.map((l) => ({
        id: l.id,
        name: l.name,
        visible: l.visible,
        opacity: l.opacity,
        data: new Uint8ClampedArray(l.imageData.data),
      })),
    };
  }

  restore(snap: DocSnapshot): void {
    // Snapshots carry the doc dimensions — restoring across a resize boundary
    // (undo of an upscale/crop) must restore the coordinate space too.
    this._width = snap.width;
    this._height = snap.height;
    this.dirtyByLayer.clear();
    this.layers = snap.layers.map((l) => {
      const img = new ImageData(snap.width, snap.height);
      img.data.set(l.data);
      return { id: l.id, name: l.name, visible: l.visible, opacity: l.opacity, imageData: img };
    });
    this.activeLayerId = snap.activeLayerId;
    this.markAllDirty();
  }
}
