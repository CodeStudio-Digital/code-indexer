/**
 * Sprite Studio — row shapes + domain enums shared by the stores
 * (migration 196) and the http-api routes / job runner.
 *
 * The repo files (`.sprite-studio/project.json`, `asset.json`) are the
 * source of truth; these rows are the queryable operational mirror. JSON
 * columns (`*_json`) are parsed into typed fields by each store's mapRow.
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
 * Style profile embedded in `sprite_projects.style_json` — the project-wide
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
  id: number;
  project_id: number;
  name: string;
  style: SpriteStyleConfig;
  export_dir: string;
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface SpriteAssetRow {
  id: number;
  sprite_project_id: number;
  slug: string;
  display_name: string;
  /** App-owned vocabulary (character|enemy|prop|item|tile|...) — no DB CHECK. */
  category: string;
  tags: string[];
  status: SpriteAssetStatus;
  current_version_id: number | null;
  anchor_reference_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface SpriteAssetVersionRow {
  id: number;
  asset_id: number;
  version: number;
  file_rel_path: string;
  width: number | null;
  height: number | null;
  source: SpriteVersionSource;
  prompt: string | null;
  user_intent: string | null;
  gen_params: Record<string, unknown> | null;
  parent_version_id: number | null;
  job_id: number | null;
  content_hash: string | null;
  created_at: string;
}

export interface SpriteReferenceRow {
  id: number;
  sprite_project_id: number;
  asset_id: number | null;
  /** 'moodboard' | 'character_sheet' | 'palette' | 'pose' (app-owned vocabulary). */
  kind: string;
  file_rel_path: string;
  notes: string | null;
  created_at: string;
}

/** Animation playback mode (sprite_animations.loop_mode). */
export type SpriteLoopMode = 'loop' | 'once' | 'pingpong';

export interface SpriteAnimationRow {
  id: number;
  asset_id: number;
  /** 'walk', 'idle', 'custom:*' — UNIQUE per asset. */
  name: string;
  fps: number;
  loop_mode: SpriteLoopMode;
  status: string;
  /** Free-form settings (frameCount, direction, …) from settings_json. */
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** A frame POINTS AT an immutable asset-version row (provenance, per-frame re-roll). */
export interface SpriteFrameRow {
  id: number;
  animation_id: number;
  frame_index: number;
  version_id: number;
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
  id: number;
  sprite_project_id: number;
  asset_id: number | null;
  kind: SpriteJobKind;
  status: SpriteJobStatus;
  user_intent: string | null;
  expanded_prompt: string | null;
  request: Record<string, unknown> | null;
  provider_id: string | null;
  model_id: string | null;
  cost_usd: number | null;
  error: string | null;
  result_version_id: number | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}
