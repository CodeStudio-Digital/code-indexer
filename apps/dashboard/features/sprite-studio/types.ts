/**
 * Sprite Studio — shared domain types (single source of truth for the
 * frontend↔backend contract, per the plan's PARTE 3 §3.1 / PARTE 2 §2.6).
 * The backend stores/routes import-or-mirror these shapes; job/SSE types
 * live in ./jobs/job-types.ts.
 */

// ─── Categories (flat vocab; the UI groups them into 7 visual groups) ───
export type SpriteCategory =
  | 'character' | 'enemy' | 'npc' | 'creature' | 'prop' | 'item' | 'icon'
  | 'weapon' | 'equipment' | 'tile' | 'tileset' | 'environment' | 'effect'
  | 'projectile' | 'ui' | 'portrait' | 'emote' | 'background' | 'misc';

export type CategoryGroupId =
  | 'characters' | 'enemies' | 'items' | 'tiles' | 'effects' | 'ui' | 'other';

export interface CategoryGroup {
  id: CategoryGroupId;
  /** i18n key suffix under the `group.` prefix of the spriteStudio namespace. */
  labelKey: string;
  categories: SpriteCategory[];
}

/** The 7 fixed visual groups of the library tree (plan §2.6 item 4). */
export const CATEGORY_GROUPS: readonly CategoryGroup[] = [
  { id: 'characters', labelKey: 'group.characters', categories: ['character', 'npc', 'portrait', 'emote'] },
  { id: 'enemies', labelKey: 'group.enemies', categories: ['enemy', 'creature'] },
  { id: 'items', labelKey: 'group.items', categories: ['prop', 'item', 'icon', 'weapon', 'equipment'] },
  { id: 'tiles', labelKey: 'group.tiles', categories: ['tile', 'tileset', 'environment', 'background'] },
  { id: 'effects', labelKey: 'group.effects', categories: ['effect', 'projectile'] },
  { id: 'ui', labelKey: 'group.ui', categories: ['ui'] },
  { id: 'other', labelKey: 'group.other', categories: ['misc'] },
];

/** Which visual group a category belongs to (misc/unknown → 'other'). */
export function groupOfCategory(category: SpriteCategory): CategoryGroupId {
  for (const g of CATEGORY_GROUPS) if (g.categories.includes(category)) return g.id;
  return 'other';
}

// ─── Style profile (mirrors SpriteStyleConfig on the store side) ────────
export type PaletteMode = 'fixed' | 'maxColors' | 'free';
export type Perspective = 'side' | 'top-down' | 'three-quarter' | 'isometric';
export type LightDirection = 'top-left' | 'top' | 'top-right' | 'front';
export type OutlineStyle = 'none' | 'black' | 'colored' | 'selective';
export type Proportions = 'chibi' | 'compact' | 'heroic' | 'realistic' | 'custom';
export type DetailLevel = 'low' | 'medium' | 'high';
export type Shading = 'flat' | 'two-tone' | 'soft' | 'dithered' | 'cel';
export type BackgroundMode = 'transparent' | 'keyColor' | 'scene';

export interface CanvasSettings {
  width: number;
  height: number;
  /** Hi-res generation size; the pipeline downscales to the canvas. */
  workingSize: number;
}

export interface PaletteSettings {
  mode: PaletteMode;
  /** Hex colors when mode === 'fixed'. */
  colors: string[];
  /** Cap when mode === 'maxColors'. */
  maxColors: number | null;
  /** Named preset (PICO-8, DB32, …) when one was picked. */
  presetName: string | null;
}

export interface OutlineSettings {
  style: OutlineStyle;
  thickness: number;
}

export interface StudioSettings {
  canvas: CanvasSettings;
  /** Forces the downscale+quantize pixel pipeline. */
  pixelPerfect: boolean;
  palette: PaletteSettings;
  perspective: Perspective;
  light: LightDirection;
  outline: OutlineSettings;
  proportions: Proportions;
  detailLevel: DetailLevel;
  shading: Shading;
  antiAliasing: boolean;
  background: BackgroundMode;
  styleKeywords: string[];
  negativeKeywords: string[];
}

export const DEFAULT_STUDIO_SETTINGS: StudioSettings = {
  canvas: { width: 32, height: 32, workingSize: 1024 },
  pixelPerfect: true,
  palette: { mode: 'free', colors: [], maxColors: null, presetName: null },
  perspective: 'side',
  light: 'top-left',
  outline: { style: 'black', thickness: 1 },
  proportions: 'compact',
  detailLevel: 'medium',
  shading: 'two-tone',
  antiAliasing: false,
  background: 'transparent',
  styleKeywords: [],
  negativeKeywords: [],
};

/** Canvas size presets offered by the new-asset dialog / settings. */
export const CANVAS_PRESETS: readonly number[] = [16, 24, 32, 48, 64, 96, 128, 256];

// ─── Domain rows (frontend mirror of the DB index / repo manifests) ─────
export type SpriteAssetStatus = 'draft' | 'approved' | 'archived' | 'missing';
export type VersionSource = 'generated' | 'imported' | 'edited' | 'processed';

export interface SpriteAsset {
  id: number;
  spriteProjectId: number;
  slug: string;
  name: string;
  category: SpriteCategory;
  tags: string[];
  status: SpriteAssetStatus;
  currentVersionId: number | null;
  width: number;
  height: number;
  /** Thumb of the current version; null while the asset has no version. */
  thumbUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Immutable version row (full provenance lives on the backend manifest). */
export interface AssetVersion {
  id: number;
  assetId: number;
  version: number;
  fileUrl?: string | null;
  thumbUrl?: string | null;
  width: number;
  height: number;
  source: VersionSource;
  prompt: string | null;
  parentVersionId: number | null;
  jobId: number | null;
  /** SHA256 of the file — in-place overwrites keep the id, change the hash
   *  (thumb/file URL cache-bust handle). */
  contentHash?: string | null;
  createdAt: string;
}

/** One sprite project per repo (MVP). */
export interface SpriteProjectInfo {
  id: number;
  projectId: number;
  name: string;
  settings: StudioSettings;
  /** Bumped on every settings change; versions snapshot the value they used. */
  styleVersion: number;
  exportDir: string;
  createdAt: string;
  updatedAt: string;
}

/** GET project response — `initialized:false` means no `.sprite-studio/` yet. */
export interface GetProjectResult {
  initialized: boolean;
  project: SpriteProjectInfo | null;
}

/** Studio center-surface mode. 'export' opens as a dialog in the MVP and
 *  'animate' is Fase 2 — the enum reserves both so the toolbar/persistence
 *  never need a migration. */
export type StudioMode = 'generate' | 'edit' | 'export' | 'animate';
