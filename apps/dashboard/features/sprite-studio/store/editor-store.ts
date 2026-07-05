/**
 * High-frequency editor UI state (tool, colors, undo/zoom readouts) — the
 * zustand half of the "4 houses" split. Pixels/layers/undo live in the
 * EditorEngine outside React; the engine pushes throttled summaries here via
 * `applyEngineSummary` (wired to engine.setSummaryListener). Components read
 * with selectors; the engine/tools write imperatively via the actions helper
 * (mirrors state/editor-chat-context.ts).
 */
import { create } from 'zustand';
import type { EngineSummary } from '../engine/engine-types.js';
import type { ToolId, ToolOptions } from '../tools/tool-types.js';

/** Reserved for Phase 2 playback — typed now so the slice shape is stable. */
export interface AnimationSlice {
  frame: number;
  playing: boolean;
  fps: number;
}

export const DEFAULT_TOOL_OPTIONS: ToolOptions = {
  size: 1,
  softness: 0,
  tolerance: 0,
  contiguous: true,
  shape: 'square',
  opacity: 100,
  shapeFill: false,
  mirrorX: false,
  dither: false,
};

/** MRU cap for the recent-colors row in the options bar. */
export const MAX_RECENT_COLORS = 10;

interface SpriteEditorState {
  activeTool: ToolId;
  toolOptions: ToolOptions;
  fgColor: string;
  bgColor: string;
  /** MRU of foreground picks (deduped, newest first, ≤ MAX_RECENT_COLORS). */
  recentColors: string[];

  // Synced FROM the engine (throttled ≤10Hz) — never set these directly.
  canUndo: boolean;
  canRedo: boolean;
  hasSelection: boolean;
  zoomPct: number;
  memBytes: number;
  docW: number;
  docH: number;
  layerCount: number;
  /** Unsaved edits since the last load/save (tab dot + close confirm). */
  dirty: boolean;

  animation?: AnimationSlice;

  setActiveTool: (tool: ToolId) => void;
  setToolOptions: (patch: Partial<ToolOptions>) => void;
  setFgColor: (hex: string) => void;
  setBgColor: (hex: string) => void;
  swapColors: () => void;
  /** Engine → store bridge; churn-guarded so identical summaries no-op. */
  applyEngineSummary: (s: EngineSummary) => void;
}

export const useSpriteEditorStore = create<SpriteEditorState>((set) => ({
  // Neutral pointer by default — opening the editor must never paint by accident.
  activeTool: 'pointer',
  toolOptions: { ...DEFAULT_TOOL_OPTIONS },
  fgColor: '#000000',
  bgColor: '#ffffff',
  recentColors: [],

  canUndo: false,
  canRedo: false,
  hasSelection: false,
  zoomPct: 100,
  memBytes: 0,
  docW: 0,
  docH: 0,
  layerCount: 0,
  dirty: false,

  setActiveTool: (tool) => set((s) => (s.activeTool === tool ? s : { activeTool: tool })),

  setToolOptions: (patch) => set((s) => ({ toolOptions: { ...s.toolOptions, ...patch } })),

  setFgColor: (hex) =>
    set((s) => {
      if (s.fgColor === hex) return s; // churn guard — repeat picks no-op
      const recentColors = [hex, ...s.recentColors.filter((c) => c !== hex)].slice(0, MAX_RECENT_COLORS);
      return { fgColor: hex, recentColors };
    }),

  setBgColor: (hex) => set((s) => (s.bgColor === hex ? s : { bgColor: hex })),

  swapColors: () => set((s) => ({ fgColor: s.bgColor, bgColor: s.fgColor })),

  applyEngineSummary: (sum) =>
    set((s) => {
      if (
        s.canUndo === sum.canUndo &&
        s.canRedo === sum.canRedo &&
        s.hasSelection === sum.hasSelection &&
        s.zoomPct === sum.zoomPct &&
        s.memBytes === sum.memBytes &&
        s.docW === sum.docW &&
        s.docH === sum.docH &&
        s.layerCount === sum.layerCount &&
        s.dirty === sum.dirty
      ) {
        return s;
      }
      return {
        canUndo: sum.canUndo,
        canRedo: sum.canRedo,
        hasSelection: sum.hasSelection,
        zoomPct: sum.zoomPct,
        memBytes: sum.memBytes,
        docW: sum.docW,
        docH: sum.docH,
        layerCount: sum.layerCount,
        dirty: sum.dirty,
      };
    }),
}));

/** Imperative accessor for engine wiring (write from outside React). */
export function spriteEditorActions() {
  return useSpriteEditorStore.getState();
}
