/**
 * Persistent workbench layout state.
 *
 * Visibility/selection lives here; panel dimensions are persisted by
 * react-resizable-panels using project-scoped autoSaveIds. Keeping a single
 * owner for sizes avoids the old v2 split-brain state, where pixel fields were
 * written to localStorage but never consumed by the rendered shell.
 */

import { create } from 'zustand';

export type WorkbenchSide = 'left' | 'right' | 'bottom';
export type LeftToolId = string;
export type RightToolId = string;
export type BottomToolId = string;
export type PrimarySurfaceId = string;

export interface PersistedWorkspaceLayout {
  activeLeft: LeftToolId | null;
  activeRight: RightToolId | null;
  activeBottom: BottomToolId | null;
  primarySurface: PrimarySurfaceId;
  previewVisible: boolean;
}

interface LegacyWorkspaceLayoutV2 extends Partial<PersistedWorkspaceLayout> {
  leftSize?: number;
  rightSize?: number;
  bottomSize?: number;
}

interface WorkspaceLayoutState extends PersistedWorkspaceLayout {
  toggleLeft: (id: LeftToolId) => void;
  toggleRight: (id: RightToolId) => void;
  toggleBottom: (id: BottomToolId) => void;
  toggleTool: (side: WorkbenchSide, id: string) => void;
  togglePreview: () => void;
  setPreviewVisible: (visible: boolean) => void;
  setActiveLeft: (id: LeftToolId | null) => void;
  setActiveRight: (id: RightToolId | null) => void;
  setActiveBottom: (id: BottomToolId | null) => void;
  setPrimarySurface: (id: PrimarySurfaceId) => void;
}

export const WORKSPACE_LAYOUT_STORAGE_KEY = 'mcp-ide:workspace-layout-v3';
export const LEGACY_WORKSPACE_LAYOUT_STORAGE_KEY = 'mcp-ide:workspace-layout-v2';

export const DEFAULT_WORKSPACE_LAYOUT: PersistedWorkspaceLayout = {
  activeLeft: 'files',
  activeRight: 'chat',
  activeBottom: null,
  primarySurface: 'editor',
  previewVisible: true,
};

/** Pure migration used by both the store and focused tests. */
export function migrateWorkspaceLayoutV2(
  legacy: LegacyWorkspaceLayoutV2 | null | undefined,
): PersistedWorkspaceLayout {
  if (!legacy) return { ...DEFAULT_WORKSPACE_LAYOUT };
  return normalizeWorkspaceLayout(legacy);
}

export function normalizeWorkspaceLayout(
  value: Partial<PersistedWorkspaceLayout> | null | undefined,
): PersistedWorkspaceLayout {
  const databaseSurface = value?.primarySurface === 'databases';
  const legacySessionSurface = value?.activeLeft === 'sessions';
  const legacyApiSurface = value?.activeLeft === 'api-navigation';
  const legacySnapshotsSurface = value?.activeRight === 'snapshots';
  const requestedSurface = value?.primarySurface || DEFAULT_WORKSPACE_LAYOUT.primarySurface;
  const primarySurface = databaseSurface
    ? 'editor'
    : requestedSurface === 'editor' && legacySessionSurface
      ? 'sessions'
      : requestedSurface === 'editor' && legacyApiSurface
        ? 'api'
        : requestedSurface === 'editor' && legacySnapshotsSurface
          ? 'snapshots'
          : requestedSurface;
  return {
    activeLeft: databaseSurface
      ? 'databases'
      : legacySessionSurface || legacyApiSurface
        ? DEFAULT_WORKSPACE_LAYOUT.activeLeft
        : (value?.activeLeft === undefined ? DEFAULT_WORKSPACE_LAYOUT.activeLeft : value.activeLeft),
    activeRight: value?.activeRight === 'api-inspector' || legacySnapshotsSurface
      ? DEFAULT_WORKSPACE_LAYOUT.activeRight
      : (value?.activeRight === undefined ? DEFAULT_WORKSPACE_LAYOUT.activeRight : value.activeRight),
    activeBottom: value?.activeBottom === undefined ? DEFAULT_WORKSPACE_LAYOUT.activeBottom : value.activeBottom,
    primarySurface,
    previewVisible: value?.previewVisible ?? DEFAULT_WORKSPACE_LAYOUT.previewVisible,
  };
}

function safeParse(raw: string | null): LegacyWorkspaceLayoutV2 | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as LegacyWorkspaceLayoutV2) : null;
  } catch {
    return null;
  }
}

function loadPersisted(): PersistedWorkspaceLayout {
  if (typeof window === 'undefined') return { ...DEFAULT_WORKSPACE_LAYOUT };
  const current = safeParse(window.localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY));
  if (current) return normalizeWorkspaceLayout(current);

  const legacy = safeParse(window.localStorage.getItem(LEGACY_WORKSPACE_LAYOUT_STORAGE_KEY));
  const migrated = migrateWorkspaceLayoutV2(legacy);
  try {
    window.localStorage.setItem(WORKSPACE_LAYOUT_STORAGE_KEY, JSON.stringify(migrated));
  } catch {
    // Storage may be disabled; the in-memory migrated value is still valid.
  }
  return migrated;
}

function persist(patch: Partial<PersistedWorkspaceLayout>): void {
  if (typeof window === 'undefined') return;
  try {
    const current = normalizeWorkspaceLayout(safeParse(window.localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY)));
    window.localStorage.setItem(WORKSPACE_LAYOUT_STORAGE_KEY, JSON.stringify({ ...current, ...patch }));
  } catch {
    // localStorage full/disabled: keep the live Zustand state working.
  }
}

function toggleKey<K extends 'activeLeft' | 'activeRight' | 'activeBottom'>(
  key: K,
  id: string,
  set: (updater: (state: WorkspaceLayoutState) => Partial<WorkspaceLayoutState>) => void,
): void {
  set((state) => {
    const next = state[key] === id ? null : id;
    persist({ [key]: next });
    return { [key]: next } as Partial<WorkspaceLayoutState>;
  });
}

export const useWorkspaceLayout = create<WorkspaceLayoutState>((set) => {
  const initial = loadPersisted();
  return {
    ...initial,
    toggleLeft: (id) => toggleKey('activeLeft', id, set),
    toggleRight: (id) => toggleKey('activeRight', id, set),
    toggleBottom: (id) => toggleKey('activeBottom', id, set),
    toggleTool: (side, id) => {
      if (side === 'left') toggleKey('activeLeft', id, set);
      else if (side === 'right') toggleKey('activeRight', id, set);
      else toggleKey('activeBottom', id, set);
    },
    togglePreview: () =>
      set((state) => {
        const previewVisible = !state.previewVisible;
        persist({ previewVisible });
        return { previewVisible };
      }),
    setPreviewVisible: (previewVisible) => {
      persist({ previewVisible });
      set({ previewVisible });
    },
    setActiveLeft: (activeLeft) => {
      persist({ activeLeft });
      set({ activeLeft });
    },
    setActiveRight: (activeRight) => {
      persist({ activeRight });
      set({ activeRight });
    },
    setActiveBottom: (activeBottom) => {
      persist({ activeBottom });
      set({ activeBottom });
    },
    setPrimarySurface: (primarySurface) => {
      persist({ primarySurface });
      set({ primarySurface });
    },
  };
});

export function getWorkspaceLayoutSnapshot(): WorkspaceLayoutState {
  return useWorkspaceLayout.getState();
}
