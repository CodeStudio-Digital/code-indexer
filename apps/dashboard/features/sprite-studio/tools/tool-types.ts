/**
 * Tool strategy contracts. Tools are plain objects the engine drives from its
 * pointer entry points — no React, no DOM events, just image/screen coords
 * plus modifiers. All pixel access goes through the ToolContext.
 */
import type { EditorDocument } from '../engine/document.js';
import type { History } from '../engine/history.js';
import type { SelectionMask } from '../engine/selection-mask.js';
import type { Viewport } from '../engine/viewport.js';

export type ToolId =
  | 'pointer'
  | 'brush'
  | 'pencil'
  | 'eraser'
  | 'magic-eraser'
  | 'fill'
  | 'line'
  | 'shape-rect'
  | 'shape-ellipse'
  | 'select-rect'
  | 'select-wand'
  | 'select-lasso'
  | 'eyedropper'
  | 'move';

/** Live shape drag preview, drawn by an overlay (no pixels touched). */
export interface ShapePreview {
  kind: 'line' | 'rect' | 'ellipse';
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Stroke thickness (brush size). */
  size: number;
  /** Filled shape (rect/ellipse only). */
  fill: boolean;
  /** Foreground color at preview time (hex). */
  color: string;
}

export interface ToolPointerEvent {
  /** Image-space coordinates (fractional — tools floor as needed). */
  imageX: number;
  imageY: number;
  screenX: number;
  screenY: number;
  shift: boolean;
  alt: boolean;
  /** PointerEvent.buttons bitmask (1 = primary held). */
  buttons: number;
}

export interface ToolOptions {
  /** Brush stamp size in pixels (1–32). */
  size: number;
  /** 0 = hard pixels; >0 = PS-style hardness falloff (soft edge). */
  softness: number;
  /** Flood/wand tolerance (0–255). */
  tolerance: number;
  /** Wand/fill contiguity toggle. */
  contiguous: boolean;
  /** Wand sampling and matching controls. */
  sampleSource?: 'active' | 'merged';
  matchMode?: 'color' | 'alpha';
  colorMetric?: 'channel' | 'perceptual';
  /** Magic eraser edge cleanup radius in pixels (0 = exact flood only). */
  edgeCleanup?: number;
  /** Brush stamp shape. Default 'square' (pixel-art first). */
  shape?: 'square' | 'round';
  /** Stroke opacity 1–100 (PS Opacity: per-stroke cap; passes build up). */
  opacity?: number;
  /** Filled shapes (rect/ellipse) instead of outlines. */
  shapeFill?: boolean;
  /** Mirror strokes across the vertical center axis. */
  mirrorX?: boolean;
  /** Checkerboard 50% dither on the hard brush path. */
  dither?: boolean;
}

export interface ToolContext {
  doc: EditorDocument;
  selection: SelectionMask;
  history: History;
  viewport: Viewport;
  options: ToolOptions;
  colors: { fg: string; bg: string };
  /** Request a repaint (sets the engine's dirty flag — never renders inline). */
  invalidate(): void;
  /** Report a sampled color (eyedropper) — the engine routes it to fg. */
  pickColor(hex: string): void;
  /** Publish/clear the live shape-drag preview (optional — tests omit it). */
  setShapePreview?(preview: ShapePreview | null): void;
}

export interface Tool {
  id: ToolId;
  /** CSS cursor while this tool is active. */
  cursor: string;
  onDown(e: ToolPointerEvent, ctx: ToolContext): void;
  onMove(e: ToolPointerEvent, ctx: ToolContext): void;
  onUp(e: ToolPointerEvent, ctx: ToolContext): void;
}
