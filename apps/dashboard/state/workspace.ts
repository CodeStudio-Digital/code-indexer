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
 */

import { create } from 'zustand';

export interface OpenFile {
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

interface WorkspaceState {
  openFiles: OpenFile[];
  activeFilePath: string | null;

  openFile: (file: OpenFile) => void;
  closeFile: (path: string) => void;
  setActive: (path: string | null) => void;
  setContent: (path: string, content: string) => void;
  markClean: (path: string, lastModified: string) => void;
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

  setActive: (path) => set({ activeFilePath: path }),

  setContent: (path, content) =>
    set((s) => ({
      openFiles: s.openFiles.map((f) => (f.path === path ? { ...f, content, dirty: true } : f)),
    })),

  markClean: (path, lastModified) =>
    set((s) => ({
      openFiles: s.openFiles.map((f) => (f.path === path ? { ...f, dirty: false, lastModified } : f)),
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
