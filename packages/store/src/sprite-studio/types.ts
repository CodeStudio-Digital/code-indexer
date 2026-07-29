/**
 * Sprite Studio — filesystem entity shapes + domain enums shared by the
 * bundle repositories, HTTP routes and job runner.
 *
 * All operational identities are opaque UUID strings. The numeric
 * `project_id` below is solely the essential SQLite project-catalog identity.
 */

/** Asset lifecycle. 'missing' = mirror row whose repo file vanished (resync). */
export type SpriteAssetStatus = 'draft' | 'approved' | 'archived' | 'missing';

/** Provenance of an immutable asset version file. */
export type SpriteVersionSource = 'generated' | 'edited' | 'processed' | 'imported';

/** What a generation job does. */
export type SpriteJobKind = 'generate' | 'edit' | 'variation' | 'process';

/** Job lifecycle: queued → prompting → generating → postprocess → saving → terminal. */
export type SpriteJobStatus =
  | 'queued'
  | 'prompting'
  | 'generating'
  | 'postprocess'
  | 'saving'
  | 'done'
  | 'failed'
  | 'cancelled';

/**
 * Style profile embedded in the Sprite bundle's `project.json` — the project-wide
 * "style contract" the prompt expander compiles into every generation and
 * the post-process pipeline enforces (quantize/outline/downscale).
 */
export interface SpriteStyleConfig {
  /** Target sprite canvas; workingSize = hi-res generation size pre-downscale. */
  canvas: { width: number; height: number; workingSize: number };
  /** Forces the generate→downscale→quantize→threshold pipeline. */
  pixelPerfect: boolean;
  palette: {
    mode: 'fixed' | 'maxColors' | 'free';
    colors?: string[];
    maxColors?: number;
    presetName?: string;
  };
  perspective: 'side' | 'top-down' | 'three-quarter' | 'isometric';
  /** Light direction keyword, e.g. 'top-left'. */
  light: string;
  outline: { style: 'none' | 'black' | 'colored' | 'selective'; thickness: number };
  /** Body proportions keyword, e.g. 'chibi' | 'compact' | 'heroic' | 'realistic'. */
  proportions: string;
  detailLevel: 'minimal' | 'low' | 'medium' | 'high';
  /** Shading keyword, e.g. 'flat' | 'two-tone' | 'soft' | 'dithered' | 'cel'. */
  shading: string;
  antiAliasing: 'none' | 'internal-only' | 'full';
  background: 'transparent' | 'keyColor' | 'scene';
  /** Chroma key (e.g. '#FF00FF') when background='keyColor'. */
  keyColor?: string;
  styleKeywords: string;
  negativeKeywords: string;
}

export const DEFAULT_SPRITE_STYLE: SpriteStyleConfig = {
  canvas: { width: 32, height: 32, workingSize: 1024 },
  pixelPerfect: true,
  palette: { mode: 'free' },
  perspective: 'side',
  light: 'top-left',
  outline: { style: 'black', thickness: 1 },
  proportions: 'compact',
  detailLevel: 'medium',
  shading: 'two-tone',
  antiAliasing: 'none',
  background: 'transparent',
  styleKeywords: '',
  negativeKeywords: '',
};

export interface SpriteProjectRow {
  id: string;
  project_id: number;
  name: string;
  style: SpriteStyleConfig;
  export_dir: string;
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface SpriteAssetRow {
  id: string;
  sprite_project_id: string;
  slug: string;
  display_name: string;
  /** App-owned vocabulary (character|enemy|prop|item|tile|...) — no DB CHECK. */
  category: string;
  tags: string[];
  status: SpriteAssetStatus;
  current_version_id: string | null;
  anchor_reference_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface SpriteAssetVersionRow {
  id: string;
  asset_id: string;
  version: number;
  file_rel_path: string;
  width: number | null;
  height: number | null;
  source: SpriteVersionSource;
  prompt: string | null;
  user_intent: string | null;
  gen_params: Record<string, unknown> | null;
  parent_version_id: string | null;
  job_id: string | null;
  content_hash: string | null;
  created_at: string;
}

export interface SpriteReferenceRow {
  id: string;
  sprite_project_id: string;
  asset_id: string | null;
  /** 'moodboard' | 'character_sheet' | 'palette' | 'pose' (app-owned vocabulary). */
  kind: string;
  file_rel_path: string;
  notes: string | null;
  created_at: string;
}

/** Animation playback mode persisted in each animation entity JSON. */
export type SpriteLoopMode = 'loop' | 'once' | 'pingpong';
export type SpriteDirection = 'S' | 'N' | 'E' | 'W' | 'SE' | 'SW' | 'NE' | 'NW' | 'side' | 'custom';

export interface SpriteAnimationSettings extends Record<string, unknown> {
  frameCount?: number;
  actionKey?: string;
  direction?: SpriteDirection | string;
  exportName?: string;
  pivot?: { x: number; y: number };
  anchorVersionId?: string;
  lastGenJobId?: string;
  loopStart?: number;
  loopEnd?: number;
}

export interface SpriteAnimationRow {
  id: string;
  asset_id: string;
  /** 'walk', 'idle', 'custom:*' — UNIQUE per asset. */
  name: string;
  fps: number;
  loop_mode: SpriteLoopMode;
  status: string;
  /** Free-form settings (frameCount, direction, …) from settings_json. */
  settings: SpriteAnimationSettings;
  created_at: string;
  updated_at: string;
}

/** A frame POINTS AT an immutable asset-version row (provenance, per-frame re-roll). */
export interface SpriteFrameRow {
  id: string;
  animation_id: string;
  frame_index: number;
  version_id: string;
  /** Per-frame override; null = 1000/fps of the owning animation.
   *  TIMING RULE: only track 0 rows carry durations (shared time grid). */
  duration_ms: number | null;
  /** Animation layer (0 = Base). Cells compose bottom-up by ascending track. */
  track: number;
}

/** Animation-layer metadata (settings_json.tracks; track 0 "Base" implicit). */
export interface SpriteTrackMeta {
  id: number;
  name: string;
  visible: boolean;
}

export interface SpriteGenerationJobRow {
  id: string;
  sprite_project_id: string;
  asset_id: string | null;
  kind: SpriteJobKind;
  status: SpriteJobStatus;
  user_intent: string | null;
  expanded_prompt: string | null;
  request: Record<string, unknown> | null;
  provider_id: string | null;
  model_id: string | null;
  cost_usd: number | null;
  error: string | null;
  result_version_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}
