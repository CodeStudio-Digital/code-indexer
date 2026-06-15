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
  /**
   * Last loaded contents — `null` means "not fetched yet" (tabs open
   * instantly; the editor fetches on activation). While a Monaco model is
   * live it is the source of truth; the store only mirrors.
   */
  content: string | null;
  /** Tracked separately from content so a Cmd+Z that returns to the original
   * mtime can clear the dirty flag without a string compare on every keystroke. */
  dirty: boolean;
  /** Last on-disk mtime from files.read/write — used to detect external edits. */
  lastModified: string | null;
  /**
   * The file changed ON DISK while this tab had unsaved edits (fs-events
   * stream). Cleared by save (markClean) or by an external reload
   * (applyExternalContent). Drives the conflict badge on the tab.
   */
  externallyChanged?: boolean;
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

export interface OpenGitLog {
  kind: 'git-log';
  projectId: number;
  /** Synthetic path used as tab identity (e.g. "gitlog:feature/x"). */
  path: string;
  /** Friendly label rendered on the tab (e.g. "Log: feature/x"). */
  title: string;
  /** Branch ref the log is scoped to. */
  branch: string;
  /** True when `branch` is a remote ref (drives the checkout-as-local path). */
  isRemote: boolean;
}

export interface OpenGitStash {
  kind: 'git-stash';
  projectId: number;
  /** Synthetic path used as tab identity (e.g. "gitstash:stash@{0}"). */
  path: string;
  /** Friendly label rendered on the tab. */
  title: string;
  /** Stash ref (e.g. "stash@{0}"). */
  stashRef: string;
}

export type OpenTab = OpenFile | OpenDiff | OpenGitLog | OpenGitStash;

/**
 * Virtual tabs (diff / git-log / git-stash) carry a `title` and have no
 * on-disk identity — they never go dirty and render with their own glyph
 * rather than a file-type icon.
 */
export function isVirtualTab(f: OpenTab): f is OpenDiff | OpenGitLog | OpenGitStash {
  return f.kind === 'diff' || f.kind === 'git-log' || f.kind === 'git-stash';
}

interface WorkspaceState {
  openFiles: OpenTab[];
  activeFilePath: string | null;

  openFile: (file: OpenFile) => void;
  openDiff: (diff: OpenDiff) => void;
  openGitLog: (tab: OpenGitLog) => void;
  openGitStash: (tab: OpenGitStash) => void;
  closeFile: (path: string) => void;
  /** Close every tab except the given one. Activates the survivor. */
  closeOthers: (keepPath: string) => void;
  /** Close every tab to the right of the given one. Active stays put. */
  closeToTheRight: (anchorPath: string) => void;
  closeAll: () => void;
  setActive: (path: string | null) => void;
  setContent: (path: string, content: string) => void;
  markClean: (path: string, lastModified: string) => void;
  /** External (disk) content landed on a NON-dirty tab — replace without dirtying. */
  applyExternalContent: (path: string, content: string, lastModified: string | null) => void;
  /** Disk changed under a DIRTY tab — flag the conflict, keep the user's buffer. */
  markExternallyChanged: (path: string) => void;
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

/**
 * Indexer scratch/trash paths (`.mcp-indexer/`) are ephemeral internals
 * that get deleted out from under any tab pointing at them. Never persist
 * or restore them — a restored phantom tab drives the LSP diagnostics poll
 * into a "Could not find source file" loop.
 */
const isIndexerInternalPath = (path: string): boolean => /(^|\/)\.mcp-indexer\//.test(path);

export function loadPersistedTabs(projectId: number): PersistedTabs {
  if (typeof window === 'undefined') return { openFiles: [], activeFilePath: null };
  try {
    const raw = window.localStorage.getItem(`${TABS_STORAGE_PREFIX}${projectId}`);
    if (!raw) return { openFiles: [], activeFilePath: null };
    const parsed = JSON.parse(raw) as PersistedTabs;
    const openFiles = (Array.isArray(parsed.openFiles) ? parsed.openFiles : []).filter(
      (f) => !isIndexerInternalPath(f.path),
    );
    return {
      openFiles,
      activeFilePath: typeof parsed.activeFilePath === 'string' ? parsed.activeFilePath : null,
    };
  } catch {
    return { openFiles: [], activeFilePath: null };
  }
}

export function savePersistedTabs(projectId: number, openFiles: OpenTab[], activeFilePath: string | null): void {
  if (typeof window === 'undefined') return;
  // Drop transient surfaces (diffs, git-log/git-stash views) — only real files persist.
  const realFiles = openFiles.filter(
    (f) =>
      f.kind !== 'diff' &&
      f.kind !== 'git-log' &&
      f.kind !== 'git-stash' &&
      !isIndexerInternalPath(f.path),
  );
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

  openGitLog: (tab) =>
    set((s) => {
      const existing = s.openFiles.findIndex(
        (f) => f.path === tab.path && f.projectId === tab.projectId,
      );
      if (existing >= 0) {
        const next = [...s.openFiles];
        next[existing] = tab;
        return { openFiles: next, activeFilePath: tab.path };
      }
      return { openFiles: [...s.openFiles, tab], activeFilePath: tab.path };
    }),

  openGitStash: (tab) =>
    set((s) => {
      const existing = s.openFiles.findIndex(
        (f) => f.path === tab.path && f.projectId === tab.projectId,
      );
      if (existing >= 0) {
        const next = [...s.openFiles];
        next[existing] = tab;
        return { openFiles: next, activeFilePath: tab.path };
      }
      return { openFiles: [...s.openFiles, tab], activeFilePath: tab.path };
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
        f.path === path && (f.kind === undefined || f.kind === 'file')
          ? { ...f, content, dirty: true }
          : f,
      ),
    })),

  markClean: (path, lastModified) =>
    set((s) => ({
      openFiles: s.openFiles.map((f) =>
        f.path === path && (f.kind === undefined || f.kind === 'file')
          ? { ...f, dirty: false, lastModified, externallyChanged: false }
          : f,
      ),
    })),

  applyExternalContent: (path, content, lastModified) =>
    set((s) => ({
      openFiles: s.openFiles.map((f) =>
        f.path === path && (f.kind === undefined || f.kind === 'file')
          ? { ...f, content, dirty: false, lastModified, externallyChanged: false }
          : f,
      ),
    })),

  markExternallyChanged: (path) =>
    set((s) => ({
      openFiles: s.openFiles.map((f) =>
        f.path === path && (f.kind === undefined || f.kind === 'file')
          ? { ...f, externallyChanged: true }
          : f,
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
