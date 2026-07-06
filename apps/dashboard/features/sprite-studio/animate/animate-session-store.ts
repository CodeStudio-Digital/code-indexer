/**
 * Animate-session store (zustand) — the cross-rail glue for the animation
 * surface. The Frames browser (LEFT rail), the FrameInspector (RIGHT rail) and
 * the AnimatePanel (CENTER) live in three separate panels, so a small shared
 * store carries what has to cross between them:
 *
 *  - a UNIFIED multi-selection of versionIds (both rails select into one set);
 *  - a BRIDGE that AnimatePanel publishes (the timeline's current versionIds +
 *    the selected frame's version) and two imperative callbacks the rails call
 *    back into it (append selected versions as frames / drop frames that use
 *    doomed versions before a bulk delete).
 *
 * One studio is open at a time, so a module-level store is fine (mirrors the
 * editor-store convention). SpriteStudioView resets it on asset/project switch.
 */
import { create } from 'zustand';

/** One timeline track, summarised for the inspector's "Camadas" section. */
export interface InspectorTrack {
  id: number;
  name: string;
  visible: boolean;
  /** How many columns this track fills (non-empty cells). */
  count: number;
}

/** The animation currently loaded in the timeline — context the RIGHT-rail
 *  inspector needs (re-slice target + which asset/animation is loaded). */
export interface AnimContext {
  assetId: number;
  name: string;
  /** The last generation's job that produced this animation (re-slice source). */
  jobId: number | null;
  /** Frame count of that generation (re-slice default columns). */
  frameCount: number;
  /** That generation kept its original sheet → re-slice is available. */
  hasSheet: boolean;
}

interface AnimateSessionState {
  // ── unified multi-selection (versionIds) ──
  selected: Set<number>;
  /** Shift-range pivot (a versionId), set by the last single toggle. */
  anchorId: number | null;
  /** Checkboxes only show in select mode; off → single click drags/opens. */
  selectMode: boolean;

  // ── bridge: AnimatePanel publishes, the rails consume ──
  /** versionIds currently on the timeline (drives the "em uso" badge). */
  frameVersionIds: number[];
  /** The timeline-selected frame's version (FrameInspector focus). */
  selectedFrameVersionId: number | null;
  /** The timeline-selected frame index (re-roll target). */
  selectedFrameIndex: number | null;
  /** Append versions (in order) as new frames — set by AnimatePanel. */
  appendToTimeline: ((versionIds: number[]) => void) | null;
  /** Drop every frame pointing at one of these versions — pre-delete sync. */
  removeFramesUsing: ((versionIds: number[]) => void) | null;
  /** Repoint one frame at a version (re-roll pick) — set by AnimatePanel. */
  replaceFrameAt: ((index: number, versionId: number, track?: number, expectedVersionId?: number) => void) | null;
  /** Replace the WHOLE timeline with these versions (restore a batch). */
  setTimeline: ((versionIds: number[]) => void) | null;
  /** Tracks of the loaded animation (inspector "Camadas" separation). */
  inspectorTracks: InspectorTrack[];
  /** The active track id (highlighted in the inspector). */
  activeTrack: number;
  /** The loaded animation's context (re-slice target lives here). */
  animContext: AnimContext | null;
  /** Make a track the active one — set by AnimatePanel. */
  onActivateTrack: ((id: number) => void) | null;
  /** Toggle a track's visibility — set by AnimatePanel. */
  onToggleTrackVisible: ((id: number, visible: boolean) => void) | null;

  setSelectMode: (on: boolean) => void;
  clearSelection: () => void;
  /** Additive toggle (checkbox / ctrl-click): flip id, keep the rest. */
  toggleOne: (id: number) => void;
  /** Shift-select the contiguous run anchorId→id over the browser's flat order. */
  selectRange: (id: number, orderedIds: number[]) => void;
  /** Tri-state group header: add or remove a whole batch. */
  setGroup: (ids: number[], on: boolean) => void;
  publishBridge: (patch: BridgePatch) => void;
  resetForAsset: () => void;
}

type BridgePatch = Partial<
  Pick<AnimateSessionState,
    'frameVersionIds' | 'selectedFrameVersionId' | 'selectedFrameIndex'
    | 'appendToTimeline' | 'removeFramesUsing' | 'replaceFrameAt' | 'setTimeline'
    | 'inspectorTracks' | 'activeTrack' | 'animContext'
    | 'onActivateTrack' | 'onToggleTrackVisible'>
>;

export const useAnimateSession = create<AnimateSessionState>((set) => ({
  selected: new Set<number>(),
  anchorId: null,
  selectMode: false,
  frameVersionIds: [],
  selectedFrameVersionId: null,
  selectedFrameIndex: null,
  appendToTimeline: null,
  removeFramesUsing: null,
  replaceFrameAt: null,
  setTimeline: null,
  inspectorTracks: [],
  activeTrack: 0,
  animContext: null,
  onActivateTrack: null,
  onToggleTrackVisible: null,

  setSelectMode: (on) => set((s) => ({ selectMode: on, selected: on ? s.selected : new Set() })),
  clearSelection: () => set({ selected: new Set(), anchorId: null }),

  toggleOne: (id) =>
    set((s) => {
      const next = new Set(s.selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { selected: next, anchorId: id };
    }),

  selectRange: (id, orderedIds) =>
    set((s) => {
      if (s.anchorId == null) {
        const next = new Set(s.selected);
        next.add(id);
        return { selected: next, anchorId: id };
      }
      const a = orderedIds.indexOf(s.anchorId);
      const b = orderedIds.indexOf(id);
      if (a < 0 || b < 0) {
        const next = new Set(s.selected);
        next.add(id);
        return { selected: next, anchorId: id };
      }
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      const next = new Set(s.selected);
      for (let i = lo; i <= hi; i++) next.add(orderedIds[i]);
      return { selected: next };
    }),

  setGroup: (ids, on) =>
    set((s) => {
      const next = new Set(s.selected);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return { selected: next };
    }),

  publishBridge: (patch) => set(patch),
  resetForAsset: () =>
    set({
      selected: new Set(), anchorId: null, frameVersionIds: [],
      selectedFrameVersionId: null, selectedFrameIndex: null,
      appendToTimeline: null, removeFramesUsing: null, replaceFrameAt: null, setTimeline: null,
      inspectorTracks: [], activeTrack: 0, animContext: null,
      onActivateTrack: null, onToggleTrackVisible: null,
    }),
}));
