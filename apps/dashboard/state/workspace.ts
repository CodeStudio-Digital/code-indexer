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

export interface OpenMerge {
  kind: 'merge';
  projectId: number;
  /** Synthetic path used as tab identity (e.g. "merge:src/foo.ts"). */
  path: string;
  /** Friendly label rendered on the tab. */
  title: string;
  /** repoRoot-relative path of the conflicted file being resolved. */
  file: string;
}

export type OpenTab = OpenFile | OpenDiff | OpenGitLog | OpenGitStash | OpenMerge;

/**
 * Virtual tabs (diff / git-log / git-stash / merge) carry a `title` and
 * have no on-disk identity — they never go dirty and render with their own
 * glyph rather than a file-type icon.
 */
export function isVirtualTab(f: OpenTab): f is OpenDiff | OpenGitLog | OpenGitStash | OpenMerge {
  return f.kind === 'diff' || f.kind === 'git-log' || f.kind === 'git-stash' || f.kind === 'merge';
}

interface WorkspaceState {
  openFiles: OpenTab[];
  activeFilePath: string | null;
  /**
   * The project the editor is currently scoped to. The store holds tabs for
   * exactly ONE project at a time — `setProject` persists the outgoing project's
   * tabs and hydrates the incoming one. All views (tab bar, editor) filter by
   * this so a tab/buffer from another project can never surface (P1 isolation).
   */
  activeProjectId: number | null;

  /** Atomic project switch: persist outgoing tabs, drop them, hydrate incoming. */
  setProject: (projectId: number) => void;
  openFile: (file: OpenFile) => void;
  openDiff: (diff: OpenDiff) => void;
  openGitLog: (tab: OpenGitLog) => void;
  openGitStash: (tab: OpenGitStash) => void;
  openMerge: (tab: OpenMerge) => void;
  closeFile: (projectId: number, path: string) => void;
  /** Close every tab except the given one. Activates the survivor. */
  closeOthers: (projectId: number, keepPath: string) => void;
  /** Close every tab to the right of the given one. Active stays put. */
  closeToTheRight: (projectId: number, anchorPath: string) => void;
  closeAll: () => void;
  setActive: (path: string | null) => void;
  setContent: (projectId: number, path: string, content: string) => void;
  markClean: (projectId: number, path: string, lastModified: string) => void;
  /** External (disk) content landed on a NON-dirty tab — replace without dirtying. */
  applyExternalContent: (projectId: number, path: string, content: string, lastModified: string | null) => void;
  /** Disk changed under a DIRTY tab — flag the conflict, keep the user's buffer. */
  markExternallyChanged: (projectId: number, path: string) => void;
  /** "Keep mine" — dismiss the external-change flag WITHOUT touching content/dirty. */
  dismissExternalChange: (projectId: number, path: string) => void;
}

/** Tab identity is (path, projectId) — never path alone (two projects can share src/index.ts). */
const sameTab = (
  a: { path: string; projectId: number },
  b: { path: string; projectId: number },
): boolean => a.path === b.path && a.projectId === b.projectId;

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
  // Filter to THIS project (defesa-em-profundidade): even if a caller passes the full
  // openFiles[], we never write another project's tabs under this project's key.
  const realFiles = openFiles.filter(
    (f) =>
      f.kind !== 'diff' &&
      f.kind !== 'git-log' &&
      f.kind !== 'git-stash' &&
      f.kind !== 'merge' &&
      !isIndexerInternalPath(f.path) &&
      f.projectId === projectId,
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
  activeProjectId: null,

  setProject: (projectId) =>
    set((s) => {
      if (s.activeProjectId === projectId) return s; // idempotente
      // Persiste as abas do projeto que SAI (filtradas por segurança), depois dropa-as
      // da memória — o que permite ao janitor do editor-models dispor os modelos Monaco
      // do projeto antigo (→ documentSync didClose). Hidrata o projeto que entra com
      // content:null (refetch lazy na ativação, igual ao useEnsureFileContent).
      if (s.activeProjectId !== null) {
        savePersistedTabs(
          s.activeProjectId,
          s.openFiles.filter((f) => f.projectId === s.activeProjectId),
          s.activeFilePath,
        );
      }
      const persisted = loadPersistedTabs(projectId);
      const hydrated: OpenTab[] = persisted.openFiles
        .filter((e) => e.projectId === projectId) // guarda de migração p/ chaves contaminadas
        .map((e) => ({ kind: 'file', projectId, path: e.path, content: null, dirty: false, lastModified: null }));
      return { activeProjectId: projectId, openFiles: hydrated, activeFilePath: persisted.activeFilePath };
    }),

  openFile: (file) =>
    set((s) => {
      const existing = s.openFiles.findIndex((f) => sameTab(f, file));
      if (existing >= 0) {
        return { ...s, activeFilePath: file.path, activeProjectId: file.projectId };
      }
      return {
        openFiles: [...s.openFiles, file],
        activeFilePath: file.path,
        activeProjectId: file.projectId,
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

  openMerge: (tab) =>
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

  closeFile: (projectId, path) =>
    set((s) => {
      const idx = s.openFiles.findIndex((f) => sameTab(f, { path, projectId }));
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

  closeOthers: (projectId, keepPath) =>
    set((s) => {
      const survivor = s.openFiles.find((f) => sameTab(f, { path: keepPath, projectId }));
      if (!survivor) return s;
      return { openFiles: [survivor], activeFilePath: keepPath };
    }),

  closeToTheRight: (projectId, anchorPath) =>
    set((s) => {
      const anchorIx = s.openFiles.findIndex((f) => sameTab(f, { path: anchorPath, projectId }));
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

  setContent: (projectId, path, content) =>
    set((s) => ({
      openFiles: s.openFiles.map((f) =>
        (f.kind === undefined || f.kind === 'file') && sameTab(f, { path, projectId })
          ? { ...f, content, dirty: true }
          : f,
      ),
    })),

  markClean: (projectId, path, lastModified) =>
    set((s) => ({
      openFiles: s.openFiles.map((f) =>
        (f.kind === undefined || f.kind === 'file') && sameTab(f, { path, projectId })
          ? { ...f, dirty: false, lastModified, externallyChanged: false }
          : f,
      ),
    })),

  applyExternalContent: (projectId, path, content, lastModified) =>
    set((s) => ({
      openFiles: s.openFiles.map((f) =>
        (f.kind === undefined || f.kind === 'file') && sameTab(f, { path, projectId })
          ? { ...f, content, dirty: false, lastModified, externallyChanged: false }
          : f,
      ),
    })),

  markExternallyChanged: (projectId, path) =>
    set((s) => ({
      openFiles: s.openFiles.map((f) =>
        (f.kind === undefined || f.kind === 'file') && sameTab(f, { path, projectId })
          ? { ...f, externallyChanged: true }
          : f,
      ),
    })),

  dismissExternalChange: (projectId, path) =>
    set((s) => ({
      openFiles: s.openFiles.map((f) =>
        (f.kind === undefined || f.kind === 'file') && sameTab(f, { path, projectId })
          ? { ...f, externallyChanged: false }
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
