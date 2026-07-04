/**
 * Commit an algorithm result back into the engine's active layer using only
 * the engine's public surface (getActiveImageData, doc.snapshot/markAllDirty,
 * history.pushSnapshot, applyResizedActive, invalidate/emitSummary).
 *
 * Two paths, both consuming a pure `algorithms/*` Raster→Raster function:
 *  - SAME dimensions → undoable whole-doc snapshot command (the "whole-image
 *    ops degrade to snapshot" path the history was designed for).
 *  - DIFFERENT dimensions (upscale, crop) → engine.applyResizedActive, ALSO
 *    undoable (snapshots carry doc dims). Refused on multi-layer documents —
 *    the caller surfaces "flatten first" (`refused: 'multi-layer'`).
 */
import type { EditorEngine } from '../engine/EditorEngine.js';
import type { Raster } from '../algorithms/image-data.js';

export type RasterOp = (input: Raster) => Raster;

export interface ApplyResult {
  ok: boolean;
  /** True when the op was committed but is NOT on the undo stack (legacy resize path). */
  historyCleared: boolean;
  /** Set when the op was refused (e.g. resize on a multi-layer document). */
  refused?: 'multi-layer';
}

/** Read the active layer pixels as a Raster (ImageData is structurally one). */
export function activeRaster(engine: EditorEngine): Raster | null {
  const img = engine.getActiveImageData();
  return img ? { data: img.data, width: img.width, height: img.height } : null;
}

/** Run a preview op and return the result without touching the document. */
export function previewOp(engine: EditorEngine, op: RasterOp): Raster | null {
  const src = activeRaster(engine);
  return src ? op({ data: new Uint8ClampedArray(src.data), width: src.width, height: src.height }) : null;
}

export function applyRasterOp(engine: EditorEngine, op: RasterOp, label: string): ApplyResult {
  const layer = engine.doc.activeLayer;
  const src = activeRaster(engine);
  if (!layer || !src) return { ok: false, historyCleared: false };
  const result = op({ data: new Uint8ClampedArray(src.data), width: src.width, height: src.height });

  // Same-size → undoable snapshot command; different-size → loadFromImage.
  if (result.width === src.width && result.height === src.height) {
    const before = engine.doc.snapshot();
    layer.imageData.data.set(result.data);
    engine.doc.markAllDirty(layer.id);
    const after = engine.doc.snapshot();
    engine.history.pushSnapshot(before, after, label);
    engine.invalidate();
    engine.emitSummary();
    return { ok: true, historyCleared: false };
  }

  // Allocate a fresh ImageData and copy in (the (data,w,h) overload rejects a
  // Uint8ClampedArray whose buffer type is ArrayBufferLike vs ArrayBuffer).
  const img = new ImageData(result.width, result.height);
  img.data.set(result.data);
  // Dimension change: UNDOABLE whole-doc snapshot (doc dims are snapshot-
  // carried now). Refused on multi-layer docs — resizing one of N layers
  // would desync the rest; the caller tells the user to flatten first.
  if (!engine.applyResizedActive(img, label)) {
    return { ok: false, historyCleared: false, refused: 'multi-layer' };
  }
  return { ok: true, historyCleared: false };
}
