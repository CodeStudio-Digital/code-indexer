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
import type { SshConnectSpec } from '@mcp/api-bus';
import type { DbEngine, WorkTab } from '../features/db-client/types.js';

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
  /** Selected git root (submodule / nested repo) the log is scoped to; undefined
   *  = main. The Git window decouples into this editor-pane tab, so the selection
   *  must ride along or log/cherry-pick/revert/reset would hit the main repo. */
  repoPath?: string;
  /** Ephemeral navigation state retained while this virtual tab stays open.
   * GitLogView is unmounted when a commit diff takes focus, so this state must
   * live with the tab rather than inside the view component. */
  viewState?: GitLogViewState;
}

export interface GitLogViewState {
  selectedSha: string | null;
  scrollOffset: number;
  limit: number;
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
  /** Selected git root (submodule / nested repo) the stash belongs to; undefined
   *  = main. Carried so stashDetail/stashFileDiff read the right repo's stash. */
  repoPath?: string;
}

export interface OpenMerge {
  kind: 'merge';
  projectId: number;
  /** Synthetic path used as tab identity (e.g. "merge:src/foo.ts"). */
  path: string;
  /** Friendly label rendered on the tab. */
  title: string;
  /** PROJECT-relative path of the conflicted file (the backend auto-routes it to
   *  its containing repo; ConflictsView rebases mergeState's repoRoot-relative
   *  paths to project-relative before opening this tab). */
  file: string;
}

/**
 * A remote file opened from the SFTP browser for in-editor editing. Unlike a
 * regular `OpenFile`, its bytes never touch the project filesystem: the Monaco
 * model holds the content in memory, `save` re-uploads over SFTP, and closing
 * the tab simply disposes the model (nothing to clean up on disk). It is
 * editable (carries `dirty`), so it is NOT an `isVirtualTab`, but it has its
 * own mount + save/close lifecycle (see SftpEditMount / sftp-edit-session).
 */
export interface OpenSftpFile {
  kind: 'sftp';
  projectId: number;
  /** Synthetic tab identity: `sftp:<hostId>:<remotePath>`. Its basename drives the tab label + file icon. */
  path: string;
  /** Absolute remote path being edited. */
  remotePath: string;
  /** Live connect spec (in-memory only — never persisted to localStorage). */
  spec: SshConnectSpec;
  /** Host label for the tab tooltip. */
  hostLabel: string;
  /** Last-saved content — seeds the Monaco model and resets on save. */
  content: string;
  /** Unsaved-edits flag (drives the tab dot). */
  dirty: boolean;
}

/** Database object/query opened as a first-class editor tab. */
export interface OpenDatabaseTab {
  kind: 'database';
  projectId: number;
  /** Synthetic identity, stable for tables and unique for ad-hoc queries. */
  path: string;
  title: string;
  workTab: WorkTab;
  engine?: DbEngine;
  suggestions: string[];
}

export type OpenTab = OpenFile | OpenDiff | OpenGitLog | OpenGitStash | OpenMerge | OpenSftpFile | OpenDatabaseTab;

/**
 * Virtual tabs (diff / git-log / git-stash / merge) carry a `title` and
 * have no on-disk identity — they never go dirty and render with their own
 * glyph rather than a file-type icon.
 */
export function isVirtualTab(f: OpenTab): f is OpenDiff | OpenGitLog | OpenGitStash | OpenMerge | OpenDatabaseTab {
  return f.kind === 'diff' || f.kind === 'git-log' || f.kind === 'git-stash' || f.kind === 'merge' || f.kind === 'database';
}

/**
 * Editor split layout (IntelliJ-style "dividir em dois"). The document POOL
 * stays in `openFiles`; a thin pane layer on top decides which tabs each
 * editor area shows and in what order.
 *
 * Invariant (single project at a time): every open path lives in EXACTLY ONE
 * pane — the union of every pane's `order` equals the active project's open
 * paths. Splitting only ever creates a SECOND, empty pane (the user's choice:
 * "painel novo nasce vazio"); the user then drags a tab into it or opens a
 * file with that pane focused.
 */
export interface EditorPaneState {
  /** Session-unique, monotonically minted ("pane-1", "pane-2", …). Never reused. */
  id: string;
  /** Tab paths shown in this pane, in display order. Subset of the pool's paths. */
  order: string[];
  /** Focused tab in this pane (null only while the pane is empty). */
  activePath: string | null;
}

/** `null` ⇔ single pane. 'row' = side-by-side (vertical divider). 'column' = stacked. */
export type SplitDir = 'row' | 'column' | null;

// Deterministic pane ids (no Math.random / Date.now): a module counter.
let paneSeq = 0;
const nextPaneId = (): string => `pane-${++paneSeq}`;
/** Test hook — reset the pane-id counter so ids are predictable across cases. */
export function __resetPaneSeqForTests(): void {
  paneSeq = 0;
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

  /** Editor panes (1 = single, 2 = split). */
  panes: EditorPaneState[];
  /** Split orientation, or null when single-pane. */
  splitDir: SplitDir;
  /** Pane that currently has focus — receives new opens, drives `activeFilePath`. */
  activePaneId: string;

  /** Atomic project switch: persist outgoing tabs, drop them, hydrate incoming. */
  setProject: (projectId: number) => void;
  openFile: (file: OpenFile) => void;
  openDiff: (diff: OpenDiff) => void;
  openGitLog: (tab: OpenGitLog) => void;
  setGitLogViewState: (projectId: number, path: string, viewState: GitLogViewState) => void;
  openGitStash: (tab: OpenGitStash) => void;
  openMerge: (tab: OpenMerge) => void;
  /** Open a database table/query/result in the normal editor tab strip. */
  openDatabaseTab: (tab: OpenDatabaseTab) => void;
  /** Update a retained database tab without refocusing the editor surface. */
  updateDatabaseTab: (projectId: number, path: string, patch: Partial<OpenDatabaseTab>) => void;
  /** Open (or focus, if already open) a remote file from SFTP for in-editor editing. */
  openSftpFile: (tab: OpenSftpFile) => void;
  /** Flip the unsaved-edits dot on an open SFTP tab. */
  setSftpDirty: (projectId: number, path: string, dirty: boolean) => void;
  /** A remote save landed — sync the tab's last-saved content + clear dirty. */
  markSftpSaved: (projectId: number, path: string, content: string) => void;
  /** Close by identity — finds the owning pane (external/back-compat entry point). */
  closeFile: (projectId: number, path: string) => void;
  /** Close a tab in a SPECIFIC pane (UI entry point — X / middle-click). */
  closeTabInPane: (paneId: string, projectId: number, path: string) => void;
  /** Close every tab except the given one, within its pane. Activates the survivor. */
  closeOthers: (projectId: number, keepPath: string) => void;
  /** Close every tab to the right of the given one, within its pane. */
  closeToTheRight: (projectId: number, anchorPath: string) => void;
  closeAll: () => void;
  setActive: (path: string | null) => void;
  /** Focus a pane (and surface its active tab). */
  setActivePane: (paneId: string) => void;
  /** Split into two panes (the new pane starts empty) or re-orient an existing split. */
  splitEditor: (dir: 'row' | 'column') => void;
  /** Collapse the split, merging the second pane's tabs back into the first. */
  unsplit: () => void;
  /** Reorder a tab within its pane — insert `fromPath` before `beforePath` (null = append). */
  reorderTab: (paneId: string, fromPath: string, beforePath: string | null) => void;
  /** Move a tab between panes — insert before `beforePath` (null = append). Collapses an emptied source. */
  moveTabToPane: (fromPaneId: string, toPaneId: string, path: string, beforePath: string | null) => void;
  /** Mark a live Monaco buffer dirty without copying its full text into React state. */
  markEditorDirty: (projectId: number, path: string) => void;
  /** Refresh the debounced Monaco mirror without changing the current dirty state. */
  syncEditorContent: (projectId: number, path: string, content: string) => void;
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

// ─── Pane helpers (pure) ──────────────────────────────────────────

const arraysEqual = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/** `activeFilePath` is a mirror of the FOCUSED pane's active tab (back-compat). */
const focusedActivePath = (panes: EditorPaneState[], activePaneId: string): string | null =>
  panes.find((p) => p.id === activePaneId)?.activePath ?? null;

/** Insert `item` before `beforePath` (null = append), removing any prior copy. */
const insertBefore = (order: string[], item: string, beforePath: string | null): string[] => {
  const base = order.filter((p) => p !== item);
  if (beforePath === null) return [...base, item];
  const idx = base.indexOf(beforePath);
  return idx < 0 ? [...base, item] : [...base.slice(0, idx), item, ...base.slice(idx)];
};

/** Add `path` to the active pane's order (if absent) and focus it; or focus the pane already holding it. */
const placePath = (
  panes: EditorPaneState[],
  activePaneId: string,
  path: string,
): { panes: EditorPaneState[]; activePaneId: string } => {
  const holder = panes.find((p) => p.order.includes(path));
  if (holder) {
    return {
      panes: panes.map((p) => (p.id === holder.id ? { ...p, activePath: path } : p)),
      activePaneId: holder.id,
    };
  }
  return {
    panes: panes.map((p) =>
      p.id === activePaneId
        ? { ...p, order: p.order.includes(path) ? p.order : [...p.order, path], activePath: path }
        : p,
    ),
    activePaneId,
  };
};

/**
 * Open/refresh a virtual tab (diff / git-log / git-stash / merge) in the pool +
 * focus it in the right pane. These tabs are upserted (re-clicking the row in
 * Git regenerates the payload), unlike regular files which only append.
 */
const upsertVirtualTab = (
  s: WorkspaceState,
  tab: OpenDiff | OpenGitLog | OpenGitStash | OpenMerge | OpenDatabaseTab,
): Partial<WorkspaceState> => {
  const existing = s.openFiles.findIndex((f) => sameTab(f, tab));
  const openFiles = existing >= 0
    ? s.openFiles.map((f, i) => {
        if (i !== existing) return f;
        // Re-opening a branch log refreshes its descriptor without throwing
        // away the user's position inside that already-open virtual tab.
        if (f.kind === 'git-log' && tab.kind === 'git-log' && f.viewState) {
          return { ...tab, viewState: f.viewState };
        }
        return tab;
      })
    : [...s.openFiles, tab];
  const { panes, activePaneId } = placePath(s.panes, s.activePaneId, tab.path);
  return { openFiles, panes, activePaneId, activeFilePath: tab.path };
};

/**
 * Editor-hosted tabs can be opened from another primary surface (Git, Database,
 * SSH, etc.). The workbench keeps the editor mounted behind those surfaces, so
 * updating the store alone is not enough to make the newly-opened tab visible.
 *
 * Reuse the existing cross-pane request consumed by ProjectView. Dispatching
 * after every open (including an in-place refresh of the same synthetic path)
 * is intentional: the user may have left the editor surface since the tab was
 * first opened.
 */
const requestEditorSurface = (projectId: number) => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('mcp:open-files-tab', { detail: { projectId } }));
};

/**
 * Close a tab: drop the (projectId, path) tuple from the pool and the `path`
 * from the owning pane (activating its neighbor), then collapse the split if
 * the closing emptied a pane.
 */
const closeTabReducer = (
  s: WorkspaceState,
  paneId: string,
  projectId: number,
  path: string,
): Partial<WorkspaceState> => {
  const poolIdx = s.openFiles.findIndex((f) => sameTab(f, { path, projectId }));
  const openFiles = poolIdx >= 0 ? s.openFiles.filter((_, i) => i !== poolIdx) : s.openFiles;

  let panes = s.panes.map((p) => {
    if (p.id !== paneId) return p;
    const idx = p.order.indexOf(path);
    if (idx < 0) return p;
    const order = p.order.filter((_, i) => i !== idx);
    // Activate the neighbor on close — prefer the right side (VS Code), fall left.
    const activePath = p.activePath === path ? (order[idx] ?? order[idx - 1] ?? null) : p.activePath;
    return { ...p, order, activePath };
  });

  let splitDir = s.splitDir;
  let activePaneId = s.activePaneId;
  const mutated = panes.find((p) => p.id === paneId);
  if (splitDir && panes.length === 2 && mutated && mutated.order.length === 0) {
    // Closing the last tab of a split pane collapses the split.
    panes = panes.filter((p) => p.id !== paneId);
    splitDir = null;
    activePaneId = panes[0].id;
  }
  return { openFiles, panes, splitDir, activePaneId, activeFilePath: focusedActivePath(panes, activePaneId) };
};

// ─── Tab persistence per project ──────────────────────────────────
//
// Restore the user's open file tabs + active selection when re-opening
// the same project. Diff tabs are intentionally not persisted — their
// patch could be stale, and the user can re-click the row in Git to
// regenerate. Regular file tabs persist with content set back to ''
// so the editor refetches via apiCall('files.read', …) on activation.

const TABS_STORAGE_PREFIX = 'mcp-ide:workspace-tabs:';

interface PersistedPane {
  order: string[];
  activePath: string | null;
}
interface PersistedLayout {
  splitDir: SplitDir;
  /** 1 (single) or 2 (split) panes, real-file paths only. */
  panes: PersistedPane[];
  /** Index (0|1) of the focused pane — stored as INDEX, not the session-scoped id. */
  activePaneIndex: number;
}
interface PersistedTabs {
  openFiles: Array<{ projectId: number; path: string }>;
  /** Safe reconnectable descriptors; no credentials or live session handles. */
  databaseTabs?: OpenDatabaseTab[];
  activeFilePath: string | null;
  /** Optional — absent in legacy payloads, which hydrate as a single pane. */
  layout?: PersistedLayout;
}

/**
 * Serialize the pane layout for persistence — real paths only, empty panes
 * dropped. Returns `undefined` when there is nothing real to restore (the
 * legacy `openFiles`/`activeFilePath` fields then drive a single-pane restore).
 */
export function serializeLayout(
  panes: EditorPaneState[],
  splitDir: SplitDir,
  activePaneId: string,
  isRealPath: (path: string) => boolean,
): PersistedLayout | undefined {
  // Defesa-em-profundidade: um subscriber do store que chame com `panes`
  // ausente (ex.: call-site com aridade errada) NUNCA pode estourar dentro
  // do set() — isso derrubaria todas as mutações. Degrada para "sem layout".
  if (!Array.isArray(panes)) return undefined;
  const filtered = panes.map((p) => ({
    order: p.order.filter(isRealPath),
    activePath: p.activePath && isRealPath(p.activePath) ? p.activePath : null,
    origId: p.id,
  }));
  const nonEmpty = filtered.filter((p) => p.order.length > 0);
  if (nonEmpty.length === 0) return undefined;
  const dir: SplitDir = splitDir && nonEmpty.length === 2 ? splitDir : null;
  const out = (dir ? nonEmpty : [nonEmpty[0]]).map((p) => ({
    order: p.order,
    activePath: p.activePath && p.order.includes(p.activePath) ? p.activePath : (p.order[0] ?? null),
  }));
  let activePaneIndex = dir ? nonEmpty.findIndex((p) => p.origId === activePaneId) : 0;
  if (activePaneIndex < 0 || activePaneIndex >= out.length) activePaneIndex = 0;
  return { splitDir: dir, panes: out, activePaneIndex };
}

/**
 * Rebuild panes from persisted layout, dropping any path not in `validPaths`
 * (stale tabs from a since-edited project). Falls back to a single pane (in
 * `validPaths` order) for legacy payloads or when the layout has no survivors.
 * Mints fresh session-scoped pane ids.
 */
export function hydrateLayout(
  persisted: PersistedTabs,
  validPaths: string[],
): { panes: EditorPaneState[]; splitDir: SplitDir; activePaneId: string } {
  const valid = new Set(validPaths);
  const layout = persisted.layout;
  if (layout && Array.isArray(layout.panes) && layout.panes.length >= 1) {
    const rebuilt = layout.panes
      .map((p) => ({
        order: (Array.isArray(p.order) ? p.order : []).filter((x) => valid.has(x)),
        activePath: typeof p.activePath === 'string' && valid.has(p.activePath) ? p.activePath : null,
      }))
      .filter((p) => p.order.length > 0)
      .map((p) => ({ id: nextPaneId(), order: p.order, activePath: p.activePath ?? p.order[0] ?? null }));
    if (rebuilt.length === 2 && (layout.splitDir === 'row' || layout.splitDir === 'column')) {
      const idx = Math.min(Math.max(0, layout.activePaneIndex ?? 0), 1);
      return { panes: rebuilt, splitDir: layout.splitDir, activePaneId: rebuilt[idx].id };
    }
    if (rebuilt.length >= 1) {
      const merged =
        rebuilt.length === 1
          ? rebuilt[0]
          : { id: rebuilt[0].id, order: [...rebuilt[0].order, ...rebuilt[1].order], activePath: rebuilt[0].activePath };
      return { panes: [merged], splitDir: null, activePaneId: merged.id };
    }
  }
  // Legacy / no layout → single pane in validPaths order.
  const id = nextPaneId();
  const active =
    persisted.activeFilePath && valid.has(persisted.activeFilePath)
      ? persisted.activeFilePath
      : (validPaths[0] ?? null);
  return { panes: [{ id, order: [...validPaths], activePath: active }], splitDir: null, activePaneId: id };
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
    const databaseTabs = (Array.isArray(parsed.databaseTabs) ? parsed.databaseTabs : []).filter(
      (tab): tab is OpenDatabaseTab => tab?.kind === 'database' && tab.projectId === projectId && typeof tab.path === 'string' && !!tab.workTab,
    );
    // Defensive parse of the optional layout: drop indexer paths inside panes too.
    let layout: PersistedLayout | undefined;
    const rawLayout = parsed.layout;
    if (rawLayout && Array.isArray(rawLayout.panes)) {
      layout = {
        splitDir: rawLayout.splitDir === 'row' || rawLayout.splitDir === 'column' ? rawLayout.splitDir : null,
        panes: rawLayout.panes.map((p) => ({
          order: (Array.isArray(p?.order) ? p.order : []).filter((x) => typeof x === 'string' && !isIndexerInternalPath(x)),
          activePath: typeof p?.activePath === 'string' ? p.activePath : null,
        })),
        activePaneIndex: typeof rawLayout.activePaneIndex === 'number' ? rawLayout.activePaneIndex : 0,
      };
    }
    return {
      openFiles,
      databaseTabs,
      activeFilePath: typeof parsed.activeFilePath === 'string' ? parsed.activeFilePath : null,
      layout,
    };
  } catch {
    return { openFiles: [], activeFilePath: null };
  }
}

export function savePersistedTabs(
  projectId: number,
  openFiles: OpenTab[],
  activeFilePath: string | null,
  panes: EditorPaneState[],
  splitDir: SplitDir,
  activePaneId: string,
): void {
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
      f.kind !== 'database' && // reconnect/introspection state is session-scoped
      f.kind !== 'sftp' && // remote edits are in-memory only — never persist/restore
      !isIndexerInternalPath(f.path) &&
      f.projectId === projectId,
  );
  const databaseTabs = openFiles.filter((file): file is OpenDatabaseTab => file.kind === 'database' && file.projectId === projectId);
  const realSet = new Set([...realFiles.map((file) => file.path), ...databaseTabs.map((tab) => tab.path)]);
  const payload: PersistedTabs = {
    openFiles: realFiles.map((f) => ({ projectId: f.projectId, path: f.path })),
    databaseTabs,
    activeFilePath,
    layout: serializeLayout(panes, splitDir, activePaneId, (p) => realSet.has(p)),
  };
  try {
    window.localStorage.setItem(`${TABS_STORAGE_PREFIX}${projectId}`, JSON.stringify(payload));
  } catch {
    /* localStorage full / disabled — silently drop */
  }
}

const INITIAL_PANE_ID = nextPaneId();

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  openFiles: [],
  activeFilePath: null,
  activeProjectId: null,
  panes: [{ id: INITIAL_PANE_ID, order: [], activePath: null }],
  splitDir: null,
  activePaneId: INITIAL_PANE_ID,

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
          s.panes,
          s.splitDir,
          s.activePaneId,
        );
      }
      const persisted = loadPersistedTabs(projectId);
      const validPaths = persisted.openFiles
        .filter((e) => e.projectId === projectId) // guarda de migração p/ chaves contaminadas
        .map((e) => e.path);
      for (const tab of persisted.databaseTabs ?? []) {
        if (!validPaths.includes(tab.path)) validPaths.push(tab.path);
      }
      const { panes, splitDir, activePaneId } = hydrateLayout(persisted, validPaths);
      // Pool = union of pane orders (so pool ⊆ panes, no dangling refs).
      const poolPaths = Array.from(new Set(panes.flatMap((p) => p.order)));
      const hydrated: OpenTab[] = poolPaths.map((path) => {
        const database = persisted.databaseTabs?.find((tab) => tab.path === path);
        if (database) return database;
        return { kind: 'file', projectId, path, content: null, dirty: false, lastModified: null };
      });
      return {
        activeProjectId: projectId,
        openFiles: hydrated,
        panes,
        splitDir,
        activePaneId,
        activeFilePath: focusedActivePath(panes, activePaneId),
      };
    }),

  openFile: (file) =>
    set((s) => {
      const inPool = s.openFiles.some((f) => sameTab(f, file));
      const openFiles = inPool ? s.openFiles : [...s.openFiles, file];
      const { panes, activePaneId } = placePath(s.panes, s.activePaneId, file.path);
      return {
        openFiles,
        panes,
        activePaneId,
        activeFilePath: file.path,
        activeProjectId: file.projectId,
      };
    }),

  openDiff: (diff) => {
    set((s) => upsertVirtualTab(s, diff));
    requestEditorSurface(diff.projectId);
  },

  openGitLog: (tab) => {
    set((s) => upsertVirtualTab(s, tab));
    requestEditorSurface(tab.projectId);
  },

  setGitLogViewState: (projectId, path, viewState) =>
    set((s) => ({
      openFiles: s.openFiles.map((f) =>
        f.kind === 'git-log' && sameTab(f, { projectId, path })
          ? { ...f, viewState }
          : f,
      ),
    })),

  openGitStash: (tab) => {
    set((s) => upsertVirtualTab(s, tab));
    requestEditorSurface(tab.projectId);
  },

  openMerge: (tab) => {
    set((s) => upsertVirtualTab(s, tab));
    requestEditorSurface(tab.projectId);
  },

  openDatabaseTab: (tab) => {
    set((s) => upsertVirtualTab(s, tab));
    const state = useWorkspaceStore.getState();
    savePersistedTabs(tab.projectId, state.openFiles, state.activeFilePath, state.panes, state.splitDir, state.activePaneId);
    requestEditorSurface(tab.projectId);
  },

  updateDatabaseTab: (projectId, path, patch) => {
    set((state) => ({
      openFiles: state.openFiles.map((file) => file.kind === 'database' && sameTab(file, { projectId, path }) ? { ...file, ...patch, kind: 'database', projectId, path } : file),
    }));
    const state = useWorkspaceStore.getState();
    savePersistedTabs(projectId, state.openFiles, state.activeFilePath, state.panes, state.splitDir, state.activePaneId);
  },

  openSftpFile: (tab) => {
    set((s) => {
      // Already open (same host+remote path) → focus it, KEEPING any in-progress
      // edits rather than re-downloading over them.
      const idx = s.openFiles.findIndex((f) => sameTab(f, tab));
      const openFiles = idx >= 0 ? s.openFiles : [...s.openFiles, tab];
      const { panes, activePaneId } = placePath(s.panes, s.activePaneId, tab.path);
      return { openFiles, panes, activePaneId, activeFilePath: tab.path, activeProjectId: tab.projectId };
    });
    requestEditorSurface(tab.projectId);
  },

  setSftpDirty: (projectId, path, dirty) =>
    set((s) => ({
      openFiles: s.openFiles.map((f) =>
        f.kind === 'sftp' && sameTab(f, { path, projectId })
          ? (f.dirty === dirty ? f : { ...f, dirty }) // skip churn when unchanged
          : f,
      ),
    })),

  markSftpSaved: (projectId, path, content) =>
    set((s) => ({
      openFiles: s.openFiles.map((f) =>
        f.kind === 'sftp' && sameTab(f, { path, projectId }) ? { ...f, content, dirty: false } : f,
      ),
    })),

  closeFile: (projectId, path) => {
    set((s) => {
      const owner = s.panes.find((p) => p.order.includes(path));
      return closeTabReducer(s, owner?.id ?? s.activePaneId, projectId, path);
    });
    const state = useWorkspaceStore.getState();
    savePersistedTabs(projectId, state.openFiles, state.activeFilePath, state.panes, state.splitDir, state.activePaneId);
  },

  closeTabInPane: (paneId, projectId, path) => {
    set((s) => closeTabReducer(s, paneId, projectId, path));
    const state = useWorkspaceStore.getState();
    savePersistedTabs(projectId, state.openFiles, state.activeFilePath, state.panes, state.splitDir, state.activePaneId);
  },

  closeOthers: (projectId, keepPath) =>
    set((s) => {
      const pane = s.panes.find((p) => p.order.includes(keepPath));
      if (!pane) return s;
      const removed = new Set(pane.order.filter((p) => p !== keepPath));
      if (removed.size === 0) return s;
      const openFiles = s.openFiles.filter((f) => !(f.projectId === projectId && removed.has(f.path)));
      const panes = s.panes.map((p) =>
        p.id === pane.id ? { ...p, order: [keepPath], activePath: keepPath } : p,
      );
      // Keep focus where it was — pruning a non-focused pane's tabs shouldn't
      // steal focus (matches closeToTheRight). Same-pane case still lands on
      // keepPath since that pane's activePath was just set to it.
      return { openFiles, panes, activeFilePath: focusedActivePath(panes, s.activePaneId) };
    }),

  closeToTheRight: (projectId, anchorPath) =>
    set((s) => {
      const pane = s.panes.find((p) => p.order.includes(anchorPath));
      if (!pane) return s;
      const anchorIx = pane.order.indexOf(anchorPath);
      const keep = pane.order.slice(0, anchorIx + 1);
      const removed = new Set(pane.order.slice(anchorIx + 1));
      if (removed.size === 0) return s;
      const openFiles = s.openFiles.filter((f) => !(f.projectId === projectId && removed.has(f.path)));
      const activePath = pane.activePath && keep.includes(pane.activePath) ? pane.activePath : anchorPath;
      const panes = s.panes.map((p) => (p.id === pane.id ? { ...p, order: keep, activePath } : p));
      return { openFiles, panes, activeFilePath: focusedActivePath(panes, s.activePaneId) };
    }),

  closeAll: () =>
    set(() => {
      const id = nextPaneId();
      return {
        openFiles: [],
        activeFilePath: null,
        panes: [{ id, order: [], activePath: null }],
        splitDir: null,
        activePaneId: id,
      };
    }),

  setActive: (path) =>
    set((s) => {
      if (path === null) return { activeFilePath: null };
      const holder = s.panes.find((p) => p.order.includes(path));
      if (!holder) return { activeFilePath: path };
      const panes = s.panes.map((p) => (p.id === holder.id ? { ...p, activePath: path } : p));
      return { panes, activePaneId: holder.id, activeFilePath: path };
    }),

  setActivePane: (paneId) =>
    set((s) => {
      if (paneId === s.activePaneId) return s;
      const pane = s.panes.find((p) => p.id === paneId);
      if (!pane) return s;
      return { activePaneId: paneId, activeFilePath: pane.activePath };
    }),

  splitEditor: (dir) =>
    set((s) => {
      if (s.splitDir) {
        // Already split — re-orient only (we keep exactly two panes).
        return s.splitDir === dir ? s : { splitDir: dir };
      }
      const newPane: EditorPaneState = { id: nextPaneId(), order: [], activePath: null };
      return { panes: [...s.panes, newPane], splitDir: dir, activePaneId: newPane.id, activeFilePath: null };
    }),

  unsplit: () =>
    set((s) => {
      if (!s.splitDir || s.panes.length < 2) return s;
      const [a, b] = s.panes;
      const order = [...a.order, ...b.order.filter((p) => !a.order.includes(p))];
      // Keep the tab the user was actually looking at (the focused pane's), not
      // always pane A's.
      const focused = s.panes.find((p) => p.id === s.activePaneId);
      const activePath =
        (focused?.activePath && order.includes(focused.activePath) ? focused.activePath : null) ??
        a.activePath ??
        b.activePath ??
        order[0] ??
        null;
      const merged: EditorPaneState = { id: a.id, order, activePath };
      return { panes: [merged], splitDir: null, activePaneId: merged.id, activeFilePath: activePath };
    }),

  reorderTab: (paneId, fromPath, beforePath) =>
    set((s) => {
      const pane = s.panes.find((p) => p.id === paneId);
      if (!pane || !pane.order.includes(fromPath)) return s;
      const order = insertBefore(pane.order, fromPath, beforePath);
      if (arraysEqual(order, pane.order)) return s; // no-op
      return { panes: s.panes.map((p) => (p.id === paneId ? { ...p, order } : p)) };
    }),

  moveTabToPane: (fromPaneId, toPaneId, path, beforePath) =>
    set((s) => {
      if (fromPaneId === toPaneId) {
        const pane = s.panes.find((p) => p.id === fromPaneId);
        if (!pane || !pane.order.includes(path)) return s;
        const order = insertBefore(pane.order, path, beforePath);
        if (arraysEqual(order, pane.order)) return s;
        return { panes: s.panes.map((p) => (p.id === fromPaneId ? { ...p, order } : p)) };
      }
      const from = s.panes.find((p) => p.id === fromPaneId);
      const to = s.panes.find((p) => p.id === toPaneId);
      if (!from || !to || !from.order.includes(path)) return s;
      let panes = s.panes.map((p) => {
        if (p.id === fromPaneId) {
          const idx = p.order.indexOf(path);
          const order = p.order.filter((x) => x !== path);
          const activePath = p.activePath === path ? (order[idx] ?? order[idx - 1] ?? null) : p.activePath;
          return { ...p, order, activePath };
        }
        if (p.id === toPaneId) {
          return { ...p, order: insertBefore(p.order, path, beforePath), activePath: path };
        }
        return p;
      });
      let splitDir = s.splitDir;
      let activePaneId = toPaneId;
      const src = panes.find((p) => p.id === fromPaneId);
      if (splitDir && panes.length === 2 && src && src.order.length === 0) {
        // Moving the last tab out of a split pane collapses the split.
        panes = panes.filter((p) => p.id !== fromPaneId);
        splitDir = null;
        activePaneId = panes[0].id;
      }
      return { panes, splitDir, activePaneId, activeFilePath: focusedActivePath(panes, activePaneId) };
    }),

  markEditorDirty: (projectId, path) =>
    set((s) => {
      const needsUpdate = s.openFiles.some((f) =>
        (f.kind === undefined || f.kind === 'file') && sameTab(f, { path, projectId }) && !f.dirty);
      if (!needsUpdate) return s;
      return {
        openFiles: s.openFiles.map((f) =>
          (f.kind === undefined || f.kind === 'file') && sameTab(f, { path, projectId })
            ? { ...f, dirty: true }
            : f),
      };
    }),

  syncEditorContent: (projectId, path, content) =>
    set((s) => {
      const needsUpdate = s.openFiles.some((f) =>
        (f.kind === undefined || f.kind === 'file') && sameTab(f, { path, projectId }) && f.content !== content);
      if (!needsUpdate) return s;
      return {
        openFiles: s.openFiles.map((f) =>
          (f.kind === undefined || f.kind === 'file') && sameTab(f, { path, projectId })
            ? { ...f, content }
            : f),
      };
    }),

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
