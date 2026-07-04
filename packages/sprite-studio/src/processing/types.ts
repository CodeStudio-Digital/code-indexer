/** Raw RGBA8 bitmap — the single currency of every processing op. */
export interface RgbaImage {
  rgba: Uint8Array;
  width: number;
  height: number;
}

export type DitherMode = 'none' | 'floyd-steinberg' | 'bayer4';

export type CanvasAlign = 'center' | 'bottom';

/** 9-position placement anchors (placeOnCanvas). */
export type CanvasAnchorX = 'left' | 'center' | 'right';
export type CanvasAnchorY = 'top' | 'middle' | 'bottom';

/**
 * Serializable pipeline step. `runPipeline` (ops.ts) dispatches each entry
 * to the matching pure function; params mirror the function signatures.
 */
export type SpriteOp =
  | { op: 'quantize'; colors?: string[]; maxColors?: number; dither?: DitherMode }
  | { op: 'resize'; mode: 'nearest' | 'box'; width: number; height: number }
  | { op: 'resize'; mode: 'scale'; factor: number }
  | { op: 'removeBackground'; tolerance: number; keyColor?: string }
  /** Global sweep: clear EVERY pixel near keyColor (reserved-color semantics). */
  | { op: 'chromaKeySweep'; keyColor: string; tolerance: number }
  /** Keep only the largest opaque blob (defense against multi-subject outputs). */
  | { op: 'keepLargestComponent' }
  /** Crop to content → aspect-fit scale → center on a transparent target. */
  | { op: 'fitToCanvas'; width: number; height: number; margin?: number; align?: CanvasAlign }
  | { op: 'outline'; color: string; thickness: 1 | 2 | 3 }
  | { op: 'autoCrop'; centerOn?: { width: number; height: number; align?: CanvasAlign } }
  /** Place on a transparent canvas at any of the 9 anchor positions. */
  | { op: 'placeOnCanvas'; width: number; height: number; anchorX?: CanvasAnchorX; anchorY?: CanvasAnchorY }
  | { op: 'alphaCleanup'; threshold?: number };
