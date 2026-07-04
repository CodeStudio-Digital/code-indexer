/**
 * Shared types for the sprite editor engine. `PixelBuffer` is the structural
 * shape of `ImageData` so the pure modules (tile-diff, history) are testable
 * in node without a DOM.
 */
export interface PixelBuffer {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  /** 0..1 */
  opacity: number;
  imageData: ImageData;
}

export interface LayerSnapshot {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  data: Uint8ClampedArray;
}

/** Full-document snapshot (whole-image ops degrade to this — correct & rare). */
export interface DocSnapshot {
  width: number;
  height: number;
  activeLayerId: string | null;
  layers: LayerSnapshot[];
}

/** One captured 64px tile — `w`/`h` may be clipped at the document edges. */
export interface TilePatch {
  tx: number;
  ty: number;
  w: number;
  h: number;
  data: Uint8ClampedArray;
}

/** Cheap summary the engine pushes (throttled) to the zustand store. */
export interface EngineSummary {
  zoomPct: number;
  canUndo: boolean;
  canRedo: boolean;
  hasSelection: boolean;
  memBytes: number;
  /** Live document dims — resize ops / undo across a resize change them. */
  docW: number;
  docH: number;
  /** Lets the layer list re-read doc.layers after undo/redo of layer ops. */
  layerCount: number;
}

export interface EngineEvents {
  onSummaryChange?: (summary: EngineSummary) => void;
}
