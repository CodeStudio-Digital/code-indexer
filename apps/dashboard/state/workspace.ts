/**
 * Workspace IDE state — the "open files + tabs + layout" subset that
 * survives navigation between the file tree, editor, and chat panel.
 *
 * Kept narrow on purpose: Zustand store, no persistence yet. Layout
 * sizes saved to localStorage so the user's panel widths stick across
 * reloads but aren't entangled with the rest of the app's state.
 *
 * Open files are addressed by absolute project-relative path (the same
 * shape `files.tree` returns), so the editor + tab bar + file tree
 * never disagree about identity.
 *
 * A second tab kind — `'diff'` — lets the Git tool window open a
 * read-only diff in the editor. Diff tabs carry both sides of the
 * patch so Monaco's DiffEditor renders without another fetch.
 */

import { create } from 'zustand';

export interface OpenFile {
  /** Discriminator — regular editable file. */
  kind?: 'file';
  projectId: number;
  /** project-relative posix path, e.g. "src/index.ts" */
  path: string;
  /** Last loaded contents (the editor model is the source of truth while open). */
  content: string;
  /** Tracked separately from content so a Cmd+Z that returns to the original
   * mtime can clear the dirty flag without a string compare on every keystroke. */
  dirty: boolean;
  /** Last on-disk mtime from files.read/write — used to detect external edits. */
  lastModified: string | null;
}

export interface OpenDiff {
  kind: 'diff';
  projectId: number;
  /** Synthetic path used as the tab identity (e.g. "diff:src/foo.ts"). */
  path: string;
  /** Friendly label rendered on the tab. */
  title: string;
  /** Unified diff text. */
  patch: string;
  /** Forwarded so the tab bar can pick an icon / sort. */
  source: 'git-unstaged' | 'git-staged' | 'other';
}

export type OpenTab = OpenFile | OpenDiff;

interface WorkspaceState {
  openFiles: OpenTab[];
  activeFilePath: string | null;

  openFile: (file: OpenFile) => void;
  openDiff: (diff: OpenDiff) => void;
  closeFile: (path: string) => void;
  /** Close every tab except the given one. Activates the survivor. */
  closeOthers: (keepPath: string) => void;
  /** Close every tab to the right of the given one. Active stays put. */
  closeToTheRight: (anchorPath: string) => void;
  closeAll: () => void;
  setActive: (path: string | null) => void;
  setContent: (path: string, content: string) => void;
  markClean: (path: string, lastModified: string) => void;
}

// ─── Tab persistence per project ──────────────────────────────────
//
// Restore the user's open file tabs + active selection when re-opening
// the same project. Diff tabs are intentionally not persisted — their
// patch could be stale, and the user can re-click the row in Git to
// regenerate. Regular file tabs persist with content set back to ''
// so the editor refetches via apiCall('files.read', …) on activation.

const TABS_STORAGE_PREFIX = 'mcp-ide:workspace-tabs:';

interface PersistedTabs {
  openFiles: Array<{ projectId: number; path: string }>;
  activeFilePath: string | null;
}

export function loadPersistedTabs(projectId: number): PersistedTabs {
  if (typeof window === 'undefined') return { openFiles: [], activeFilePath: null };
  try {
    const raw = window.localStorage.getItem(`${TABS_STORAGE_PREFIX}${projectId}`);
    if (!raw) return { openFiles: [], activeFilePath: null };
    const parsed = JSON.parse(raw) as PersistedTabs;
    return {
      openFiles: Array.isArray(parsed.openFiles) ? parsed.openFiles : [],
      activeFilePath: typeof parsed.activeFilePath === 'string' ? parsed.activeFilePath : null,
    };
  } catch {
    return { openFiles: [], activeFilePath: null };
  }
}

export function savePersistedTabs(projectId: number, openFiles: OpenTab[], activeFilePath: string | null): void {
  if (typeof window === 'undefined') return;
  // Drop diff tabs — they're transient.
  const realFiles = openFiles.filter((f) => f.kind !== 'diff');
  const payload: PersistedTabs = {
    openFiles: realFiles.map((f) => ({ projectId: f.projectId, path: f.path })),
    activeFilePath,
  };
  try {
    window.localStorage.setItem(`${TABS_STORAGE_PREFIX}${projectId}`, JSON.stringify(payload));
  } catch {
    /* localStorage full / disabled — silently drop */
  }
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  openFiles: [],
  activeFilePath: null,

  openFile: (file) =>
    set((s) => {
      const existing = s.openFiles.findIndex((f) => f.path === file.path && f.projectId === file.projectId);
      if (existing >= 0) {
        return { ...s, activeFilePath: file.path };
      }
      return {
        openFiles: [...s.openFiles, file],
        activeFilePath: file.path,
      };
    }),

  openDiff: (diff) =>
    set((s) => {
      const existing = s.openFiles.findIndex((f) => f.path === diff.path && f.projectId === diff.projectId);
      if (existing >= 0) {
        // Refresh the patch in-place — same diff for the same path means
        // the user re-clicked the file in the git tool window with new
        // changes on disk.
        const next = [...s.openFiles];
        next[existing] = diff;
        return { openFiles: next, activeFilePath: diff.path };
      }
      return {
        openFiles: [...s.openFiles, diff],
        activeFilePath: diff.path,
      };
    }),

  closeFile: (path) =>
    set((s) => {
      const idx = s.openFiles.findIndex((f) => f.path === path);
      if (idx < 0) return s;
      const next = s.openFiles.filter((_, i) => i !== idx);
      // Activate the neighbor on close — preferring the right side (matches
      // VS Code), falling back to the left when closing the rightmost tab.
      let nextActive = s.activeFilePath;
      if (s.activeFilePath === path) {
        nextActive = next[idx]?.path ?? next[idx - 1]?.path ?? null;
      }
      return { openFiles: next, activeFilePath: nextActive };
    }),

  closeOthers: (keepPath) =>
    set((s) => {
      const survivor = s.openFiles.find((f) => f.path === keepPath);
      if (!survivor) return s;
      return { openFiles: [survivor], activeFilePath: keepPath };
    }),

  closeToTheRight: (anchorPath) =>
    set((s) => {
      const anchorIx = s.openFiles.findIndex((f) => f.path === anchorPath);
      if (anchorIx < 0) return s;
      const next = s.openFiles.slice(0, anchorIx + 1);
      // If the active tab was on the right side, fall back onto the anchor.
      let nextActive = s.activeFilePath;
      if (!next.some((f) => f.path === nextActive)) {
        nextActive = anchorPath;
      }
      return { openFiles: next, activeFilePath: nextActive };
    }),

  closeAll: () => set({ openFiles: [], activeFilePath: null }),

  setActive: (path) => set({ activeFilePath: path }),

  setContent: (path, content) =>
    set((s) => ({
      openFiles: s.openFiles.map((f) =>
        f.path === path && f.kind !== 'diff' ? { ...f, content, dirty: true } : f,
      ),
    })),

  markClean: (path, lastModified) =>
    set((s) => ({
      openFiles: s.openFiles.map((f) =>
        f.path === path && f.kind !== 'diff' ? { ...f, dirty: false, lastModified } : f,
      ),
    })),
}));

// ─── Layout sizes (persisted to localStorage) ─────────────────────

const LAYOUT_STORAGE_KEY = 'mcp-ide:workspace-layout';

export interface WorkspaceLayout {
  fileTreeSize: number;
  editorSize: number;
  rightPaneSize: number;
  bottomPanelOpen: boolean;
  bottomPanelSize: number;
}

const DEFAULT_LAYOUT: WorkspaceLayout = {
  fileTreeSize: 18,
  editorSize: 52,
  rightPaneSize: 30,
  bottomPanelOpen: false,
  bottomPanelSize: 30,
};

export function loadWorkspaceLayout(): WorkspaceLayout {
  if (typeof window === 'undefined') return DEFAULT_LAYOUT;
  try {
    const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) return DEFAULT_LAYOUT;
    return { ...DEFAULT_LAYOUT, ...(JSON.parse(raw) as Partial<WorkspaceLayout>) };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

export function saveWorkspaceLayout(layout: Partial<WorkspaceLayout>): void {
  if (typeof window === 'undefined') return;
  try {
    const current = loadWorkspaceLayout();
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({ ...current, ...layout }));
  } catch {
    /* localStorage full / disabled — silently drop */
  }
}
