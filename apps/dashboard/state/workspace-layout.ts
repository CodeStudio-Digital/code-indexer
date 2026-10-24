/**
 * Persistent workbench layout state.
 *
 * Visibility/selection lives here; primary/left-rail navigation is remembered
 * per project, while shared panel preferences keep their global fallback.
 * Panel dimensions are persisted by react-resizable-panels using
 * project-scoped autoSaveIds. Keeping a single owner for sizes avoids the old
 * v2 split-brain state, where pixel fields were written to localStorage but
 * never consumed by the rendered shell.
 */

import { create } from 'zustand';

type WorkbenchSide = 'left' | 'right' | 'bottom';
type LeftToolId = string;
type RightToolId = string;
type BottomToolId = string;
type PrimarySurfaceId = string;

interface PersistedWorkspaceLayout {
  activeLeft: LeftToolId | null;
  activeRight: RightToolId | null;
  activeBottom: BottomToolId | null;
  primarySurface: PrimarySurfaceId;
  previewVisible: boolean;
}

interface PersistedProjectNavigation {
  activeLeft: LeftToolId | null;
  primarySurface: PrimarySurfaceId;
}

interface LegacyWorkspaceLayoutV2 extends Partial<PersistedWorkspaceLayout> {
  leftSize?: number;
  rightSize?: number;
  bottomSize?: number;
}

interface WorkspaceLayoutState extends PersistedWorkspaceLayout {
  activateProject: (projectId: number) => void;
  deactivateProject: (projectId: number) => void;
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

const WORKSPACE_LAYOUT_STORAGE_KEY = 'mcp-ide:workspace-layout-v3';
const LEGACY_WORKSPACE_LAYOUT_STORAGE_KEY = 'mcp-ide:workspace-layout-v2';
const PROJECT_NAVIGATION_STORAGE_PREFIX = 'mcp-ide:project-navigation-v1:';

export const DEFAULT_WORKSPACE_LAYOUT: PersistedWorkspaceLayout = {
  activeLeft: 'files',
  activeRight: 'chat',
  activeBottom: null,
  primarySurface: 'editor',
  previewVisible: true,
};

export const DEFAULT_PROJECT_NAVIGATION: PersistedProjectNavigation = {
  activeLeft: 'files',
  primarySurface: 'sessions',
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

export function normalizeProjectNavigation(
  value: Partial<PersistedProjectNavigation> | null | undefined,
): PersistedProjectNavigation {
  if (!value) return { ...DEFAULT_PROJECT_NAVIGATION };
  const normalized = normalizeWorkspaceLayout({
    activeLeft: value.activeLeft === undefined ? DEFAULT_PROJECT_NAVIGATION.activeLeft : value.activeLeft,
    primarySurface: value.primarySurface || DEFAULT_PROJECT_NAVIGATION.primarySurface,
  });
  return {
    activeLeft: normalized.activeLeft,
    primarySurface: normalized.primarySurface,
  };
}

export function projectNavigationStorageKey(projectId: number): string {
  return `${PROJECT_NAVIGATION_STORAGE_PREFIX}${projectId}`;
}

function loadProjectNavigation(projectId: number): PersistedProjectNavigation | null {
  if (typeof window === 'undefined') return null;
  try {
    const stored = safeParse(window.localStorage.getItem(projectNavigationStorageKey(projectId)));
    return stored ? normalizeProjectNavigation(stored) : null;
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

function persistProjectNavigation(projectId: number, patch: Partial<PersistedProjectNavigation>): void {
  if (typeof window === 'undefined') return;
  try {
    const current = loadProjectNavigation(projectId) ?? DEFAULT_PROJECT_NAVIGATION;
    window.localStorage.setItem(
      projectNavigationStorageKey(projectId),
      JSON.stringify(normalizeProjectNavigation({ ...current, ...patch })),
    );
  } catch {
    // localStorage full/disabled: keep the live Zustand state working.
  }
}

let activeProjectId: number | null = null;

function toggleKey<K extends 'activeLeft' | 'activeRight' | 'activeBottom'>(
  key: K,
  id: string,
  set: (updater: (state: WorkspaceLayoutState) => Partial<WorkspaceLayoutState>) => void,
): void {
  set((state) => {
    const next = state[key] === id ? null : id;
    persist({ [key]: next });
    if (key === 'activeLeft' && activeProjectId !== null) {
      persistProjectNavigation(activeProjectId, { activeLeft: next });
    }
    return { [key]: next } as Partial<WorkspaceLayoutState>;
  });
}

export const useWorkspaceLayout = create<WorkspaceLayoutState>((set) => {
  const initial = loadPersisted();
  return {
    ...initial,
    activateProject: (projectId) => {
      activeProjectId = projectId;
      const navigation = loadProjectNavigation(projectId) ?? DEFAULT_PROJECT_NAVIGATION;
      persist(navigation);
      persistProjectNavigation(projectId, navigation);
      set(navigation);
    },
    deactivateProject: (projectId) => {
      if (activeProjectId === projectId) activeProjectId = null;
    },
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
      if (activeProjectId !== null) persistProjectNavigation(activeProjectId, { activeLeft });
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
      if (activeProjectId !== null) persistProjectNavigation(activeProjectId, { primarySurface });
      set({ primarySurface });
    },
  };
});

function getWorkspaceLayoutSnapshot(): WorkspaceLayoutState {
  return useWorkspaceLayout.getState();
}
