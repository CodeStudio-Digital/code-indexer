/**
 * Workspace layout state — which tool windows are pinned on the left
 * and right activity bars, which bottom panel tab is showing, panel
 * sizes. Persisted to localStorage so the user's layout sticks.
 *
 * Naming follows JetBrains: an "activity bar" is the column of icons
 * on the side; a "tool window" is the panel that opens when you click
 * an icon. Click the active icon again to collapse.
 */

import { create } from 'zustand';

// Open id types: built-ins plus any string id a plugin contributes. The
// activity rail + layout store are id-agnostic, so widening to `string` lets
// plugin-contributed tool windows participate without a union edit.
export type LeftToolId = string;
export type RightToolId = string;
export type BottomToolId = string;

interface WorkspaceLayoutState {
  activeLeft: LeftToolId | null;
  activeRight: RightToolId | null;
  activeBottom: BottomToolId | null;

  leftSize: number; // px
  rightSize: number; // px
  bottomSize: number; // px

  /** Project preview pane visibility (builder/preview-enabled projects). */
  previewVisible: boolean;

  toggleLeft: (id: LeftToolId) => void;
  toggleRight: (id: RightToolId) => void;
  toggleBottom: (id: BottomToolId) => void;
  togglePreview: () => void;
  setPreviewVisible: (visible: boolean) => void;

  setActiveLeft: (id: LeftToolId | null) => void;
  setActiveRight: (id: RightToolId | null) => void;
  setActiveBottom: (id: BottomToolId | null) => void;

  setLeftSize: (px: number) => void;
  setRightSize: (px: number) => void;
  setBottomSize: (px: number) => void;
}

const STORAGE_KEY = 'mcp-ide:workspace-layout-v2';

interface PersistedSnapshot {
  activeLeft: LeftToolId | null;
  activeRight: RightToolId | null;
  activeBottom: BottomToolId | null;
  leftSize: number;
  rightSize: number;
  bottomSize: number;
  previewVisible: boolean;
}

const DEFAULTS: PersistedSnapshot = {
  activeLeft: 'files',
  activeRight: 'chat',
  activeBottom: null,
  leftSize: 260,
  rightSize: 360,
  bottomSize: 240,
  previewVisible: true,
};

function loadPersisted(): PersistedSnapshot {
  if (typeof window === 'undefined') return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<PersistedSnapshot>) };
  } catch {
    return DEFAULTS;
  }
}

function persist(snap: Partial<PersistedSnapshot>): void {
  if (typeof window === 'undefined') return;
  try {
    const cur = loadPersisted();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...cur, ...snap }));
  } catch {
    /* localStorage full / disabled — silently drop */
  }
}

export const useWorkspaceLayout = create<WorkspaceLayoutState>((set, get) => {
  const initial = loadPersisted();
  return {
    ...initial,

    toggleLeft: (id) =>
      set((s) => {
        const next = s.activeLeft === id ? null : id;
        persist({ activeLeft: next });
        return { activeLeft: next };
      }),
    toggleRight: (id) =>
      set((s) => {
        const next = s.activeRight === id ? null : id;
        persist({ activeRight: next });
        return { activeRight: next };
      }),
    toggleBottom: (id) =>
      set((s) => {
        const next = s.activeBottom === id ? null : id;
        persist({ activeBottom: next });
        return { activeBottom: next };
      }),
    togglePreview: () =>
      set((s) => {
        const next = !s.previewVisible;
        persist({ previewVisible: next });
        return { previewVisible: next };
      }),
    setPreviewVisible: (visible) => {
      persist({ previewVisible: visible });
      set({ previewVisible: visible });
    },

    setActiveLeft: (id) => {
      persist({ activeLeft: id });
      set({ activeLeft: id });
    },
    setActiveRight: (id) => {
      persist({ activeRight: id });
      set({ activeRight: id });
    },
    setActiveBottom: (id) => {
      persist({ activeBottom: id });
      set({ activeBottom: id });
    },

    setLeftSize: (px) => {
      persist({ leftSize: px });
      set({ leftSize: px });
    },
    setRightSize: (px) => {
      persist({ rightSize: px });
      set({ rightSize: px });
    },
    setBottomSize: (px) => {
      persist({ bottomSize: px });
      set({ bottomSize: px });
    },
  };
});

// Re-export the snapshot helper for non-React readers (the status bar
// shows a count of currently-pinned tool windows).
export function getWorkspaceLayoutSnapshot(): WorkspaceLayoutState {
  return useWorkspaceLayout.getState();
}
