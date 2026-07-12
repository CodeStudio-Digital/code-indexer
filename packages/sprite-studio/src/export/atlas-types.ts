/**
 * Export layer shared shapes (plan §2.7). Adapters are pure:
 * `(ComposedSheet, ExportMeta) → JSON text`; the orchestrator (index.ts)
 * returns ExportFile[] and NEVER touches the filesystem — the http-api
 * route writes into `<repo>/<export_dir>/`.
 */
import type { RgbaImage } from '../processing/types.js';

/** Placement of one frame inside a composed sheet (pixel coords, y-down). */
export interface FrameRect {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  trimmed?: boolean;
  /** Original (untrimmed) frame size. */
  sourceSize?: { w: number; h: number };
  /** Offset+size of the trimmed rect inside the source frame. */
  spriteSourceSize?: { x: number; y: number; w: number; h: number };
  /** Normalized pivot (0..1, y-down). */
  pivot?: { x: number; y: number };
}

/** A composed spritesheet: pixels + where each frame ended up. */
export interface ComposedSheet {
  rgba: RgbaImage;
  rects: FrameRect[];
}

/** One file the caller must write (exactly one of bytes/text is set). */
export interface ExportFile {
  relPath: string;
  bytes?: Buffer;
  text?: string;
}

/** Animation entry for atlas metadata (frame names in play order). */
export interface AtlasAnimation {
  frames: string[];
  fps?: number;
  loop?: boolean;
  /** Per-frame durations in ms, parallel to `frames` (uniform fps when absent). */
  durationsMs?: number[];
  /** Playback mode; wins over `loop` when set (`loop` kept for compat). */
  loopMode?: 'loop' | 'once' | 'pingpong';
  /** Optional semantic metadata used by game importers and neutral manifests. */
  action?: string;
  direction?: string;
}

export interface ExportMeta {
  assetSlug: string;
  /** Integer nearest-neighbor scale applied to every frame. */
  scale: number;
  /** Gap between cells AND sheet border, px (post-extrude). */
  padding: number;
  /** Edge-pixel duplication per cell side, px (anti texture-bleeding). */
  extrude: number;
  /** Normalized pivot (0..1, y-down); bottom-center = {x:0.5, y:1}. */
  pivot: { x: number; y: number };
  fps?: number;
  animations?: Record<string, AtlasAnimation>;
  /** Engine-relative texture path when an adapter needs more than a filename. */
  resourcePath?: string;
}
