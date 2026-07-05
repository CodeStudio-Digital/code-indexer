/**
 * Per-project UI prefs for Sprite Studio, persisted to localStorage so the
 * collapsed library groups + last studio mode survive navigation and app
 * restarts. A separate GLOBAL key remembers the last opened project so the
 * `/sprites` route can restore it without a `?project=` param. Read-modify-
 * write merge style copied from features/api-client/api-client-ui-state.ts.
 */
import type { StudioMode } from './types.js';

/** The generation the panel was last driving — restored on remount so
 *  navigating away never "loses" an in-flight/unpicked batch. */
export interface LastGenJob {
  jobId: number;
  prompt: string;
  n: number;
  rawPrompt: boolean;
  seed: number | null;
}

export interface SpriteStudioUiState {
  /** Library category-group ids currently collapsed. */
  collapsedGroups: string[];
  /** Frames-browser generation-group keys currently collapsed (job:NN|manual). */
  collapsedFrameGroups: string[];
  /** Last active studio mode (restored on reopen). */
  lastMode: StudioMode | null;
  /** Current/last generation job of this project (rehydrated on remount). */
  lastGenJob: LastGenJob | null;
  /** Unsubmitted composer draft (prompt/count survive navigation). */
  composerDraft: { prompt: string; n: number; rawPrompt: boolean } | null;
  /** Editor pixel-grid overlay toggle (default true). */
  gridEnabled: boolean;
  /** IDE-style rail collapse state per side (default all expanded). */
  panelsCollapsed: { left: boolean; right: boolean; bottom: boolean };
  /** Active left-rail tab id ('library' | 'files' | future panel ids). */
  leftTab: string;
  /** Custom display names for generation groups, keyed by group key (job:NN|manual). */
  groupLabels: Record<string, string>;
}

const DEFAULTS: SpriteStudioUiState = {
  collapsedGroups: [], collapsedFrameGroups: [], lastMode: null, lastGenJob: null,
  composerDraft: null, gridEnabled: true,
  panelsCollapsed: { left: false, right: false, bottom: false }, leftTab: 'library',
  groupLabels: {},
};

const MODES: readonly string[] = ['generate', 'edit', 'export', 'animate'];

const keyFor = (projectId: number): string => `mcp-ide:sprite-studio-ui:${projectId}`;
const LAST_PROJECT_KEY = 'mcp-ide:sprite-studio-ui:last-project';

/** Read the persisted entry, or null when none exists. */
export function loadSpriteStudioUi(projectId: number): SpriteStudioUiState | null {
  if (typeof window === 'undefined' || !Number.isFinite(projectId)) return null;
  try {
    const raw = window.localStorage.getItem(keyFor(projectId));
    if (!raw) return null;
    const o = JSON.parse(raw) as Partial<SpriteStudioUiState>;
    const g = o.lastGenJob;
    const d = o.composerDraft;
    return {
      collapsedGroups: Array.isArray(o.collapsedGroups)
        ? o.collapsedGroups.filter((x): x is string => typeof x === 'string')
        : [],
      collapsedFrameGroups: Array.isArray(o.collapsedFrameGroups)
        ? o.collapsedFrameGroups.filter((x): x is string => typeof x === 'string')
        : [],
      lastMode: typeof o.lastMode === 'string' && MODES.includes(o.lastMode)
        ? (o.lastMode as StudioMode)
        : null,
      lastGenJob:
        g && typeof g.jobId === 'number' && typeof g.prompt === 'string'
          ? {
              jobId: g.jobId,
              prompt: g.prompt,
              n: typeof g.n === 'number' ? g.n : 4,
              rawPrompt: !!g.rawPrompt,
              seed: typeof g.seed === 'number' ? g.seed : null,
            }
          : null,
      composerDraft:
        d && typeof d.prompt === 'string'
          ? { prompt: d.prompt, n: typeof d.n === 'number' ? d.n : 4, rawPrompt: !!d.rawPrompt }
          : null,
      gridEnabled: typeof o.gridEnabled === 'boolean' ? o.gridEnabled : true,
      panelsCollapsed: {
        left: o.panelsCollapsed?.left === true,
        right: o.panelsCollapsed?.right === true,
        bottom: o.panelsCollapsed?.bottom === true,
      },
      leftTab: typeof o.leftTab === 'string' && o.leftTab.length > 0 ? o.leftTab : 'library',
      groupLabels: o.groupLabels && typeof o.groupLabels === 'object'
        ? Object.fromEntries(
            Object.entries(o.groupLabels as Record<string, unknown>)
              .filter((e): e is [string, string] => typeof e[1] === 'string'),
          )
        : {},
    };
  } catch {
    return null;
  }
}

/** Merge a partial slice into the persisted entry (read-modify-write). */
export function saveSpriteStudioUi(projectId: number, slice: Partial<SpriteStudioUiState>): void {
  if (typeof window === 'undefined' || !Number.isFinite(projectId)) return;
  try {
    const cur = loadSpriteStudioUi(projectId) ?? DEFAULTS;
    window.localStorage.setItem(keyFor(projectId), JSON.stringify({ ...cur, ...slice }));
  } catch {
    /* quota / disabled — drop silently */
  }
}

/** Last project opened in Sprite Studio (global, cross-project key). */
export function loadLastSpriteProject(): number | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(LAST_PROJECT_KEY);
    const id = raw == null ? NaN : Number(raw);
    return Number.isFinite(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

export function saveLastSpriteProject(projectId: number): void {
  if (typeof window === 'undefined' || !Number.isFinite(projectId)) return;
  try {
    window.localStorage.setItem(LAST_PROJECT_KEY, String(projectId));
  } catch {
    /* quota / disabled — drop silently */
  }
}
