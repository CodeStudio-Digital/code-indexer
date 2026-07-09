import type { ApiContext } from './common.js';

/**
 * Filesystem access scoped to a project's root_path.
 *
 * Read paths use existing routes (apps/http-api/server/routes/files.ts).
 * Write path (`writeFile`) is NEW — added by the IDE workspace (Dia 3
 * of the plan): PUT /api/projects/:id/file. The IDE editor calls this
 * on Ctrl+S.
 */

/**
 * File / symbol shapes — passed through from the SQLite store
 * (@mcp/shared/types: DBFile, DBSymbol, DBFileDependency, etc.). Typed
 * here as `unknown` so api-bus stays decoupled from the store schema
 * evolution. Consumers narrow via the existing dashboard types.
 */
export type ProjectFileSummary = unknown;
export type FileSymbol = unknown;
export type FileDetail = unknown;

export interface ManifestInfo {
  manifest: unknown;
  dockerfile: unknown;
}

/**
 * File-tree node — for the IDE FileTreeRail. NOT in the current routes;
 * added in Dia 6 with `electronAPI.api.files.tree({projectId})`.
 */
export interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: FileTreeNode[];
  /**
   * Set on dirs whose children were cut off by maxDepth — tells the lazy
   * tree whether to draw an expand chevron without fetching first.
   */
  hasChildren?: boolean;
  /**
   * Populated only when `tree` is called with `withStats: true` (the SFTP file
   * pane uses this to show size/modified/permissions columns). The default
   * FileTreeRail fast path skips the per-file stat, so these stay undefined.
   */
  size?: number;
  /** Modified time, epoch ms. Undefined unless `withStats` was requested. */
  mtime?: number;
  /** Unix permission bits (as reported by fs.stat / SFTP). Undefined unless `withStats`. */
  mode?: number;
}

/**
 * Uma revisão do Local History (sem o conteúdo — vem só no `historyGet`).
 * Espelha a linha de `file_local_history` (mig 160).
 */
export interface HistoryRevision {
  id: number;
  path: string;
  content_hash: string | null;
  size: number;
  kind: 'save' | 'external' | 'pre-delete' | 'pre-agent' | 'manual';
  label: string | null;
  existed_before: number;
  oversized: number;
  created_at: string;
}

export interface FilesApi {
  list(input: { projectId: number }, ctx: ApiContext): Promise<unknown[]>;
  manifest(input: { projectId: number }, ctx: ApiContext): Promise<ManifestInfo>;
  get(input: { projectId: number; path: string }, ctx: ApiContext): Promise<unknown>;

  /**
   * Raw read of file contents from disk (used by the Monaco editor).
   * Always returns the on-disk mtime; with `ifModifiedSince` matching it,
   * skips the read entirely (`notModified: true`, no content) — the SWR
   * revalidation path for tab switches and fs-event echoes.
   */
  read(
    input: { projectId: number; path: string; ifModifiedSince?: string },
    ctx: ApiContext,
  ): Promise<
    | { content: string; encoding: 'utf8' | 'base64'; last_modified: string }
    | { notModified: true; last_modified: string }
  >;

  /**
   * Persist editor content to disk. Returns the new on-disk mtime so the
   * client can compare with its in-memory dirty state.
   */
  write(
    input: { projectId: number; path: string; content: string; encoding?: 'utf8' | 'base64' },
    ctx: ApiContext,
  ): Promise<{ ok: true; last_modified: string }>;

  /** Delete a file (or empty directory). Refuses to delete the project root. */
  delete(input: { projectId: number; path: string; recursive?: boolean }, ctx: ApiContext): Promise<{ ok: true }>;

  /** Rename / move a file or directory within the project. */
  rename(
    input: { projectId: number; from: string; to: string },
    ctx: ApiContext,
  ): Promise<{ ok: true; last_modified: string | null }>;

  /** Create an empty directory (recursive). */
  mkdir(input: { projectId: number; path: string }, ctx: ApiContext): Promise<{ ok: true }>;

  /**
   * Recursive file tree for the IDE sidebar. `withStats` populates `size`/
   * `mtime`/`mode` on each child (one extra stat per entry) — used by the SFTP
   * file pane's columns. The default FileTreeRail fast path omits it (zero stats).
   */
  tree(input: { projectId: number; maxDepth?: number; root?: string; withStats?: boolean }, ctx: ApiContext): Promise<FileTreeNode>;

  /** Zip project files/folders into `out` (a project-relative `.zip` path). */
  archive(
    input: { projectId: number; paths: string[]; out: string },
    ctx: ApiContext,
  ): Promise<{ ok: true; path: string }>;

  /** Extract a project-relative zip into `dest` (a project-relative directory). */
  extract(
    input: { projectId: number; zip: string; dest: string },
    ctx: ApiContext,
  ): Promise<{ ok: true; files: number; bytes: number }>;

  // `projectId` (optional) routes the surrogate-id lookup to that project's DB
  // when per-project DBs are split; absent → central (pre-split behavior).
  symbol(input: { id: number; projectId?: number }, ctx: ApiContext): Promise<unknown>;
  symbolMembers(input: { id: number; projectId?: number }, ctx: ApiContext): Promise<unknown[]>;

  listConcepts(input: { projectId: number }, ctx: ApiContext): Promise<Array<{ concept: string; count: number }>>;
  conceptFiles(input: { projectId: number; concept: string }, ctx: ApiContext): Promise<unknown[]>;

  // ── Local History (mig 160) ───────────────────────────────────────
  /** Revisões de um arquivo, mais novo primeiro. */
  historyList(input: { projectId: number; path: string }, ctx: ApiContext): Promise<{ revisions: HistoryRevision[] }>;
  /** Uma revisão + seu conteúdo (null para oversized/tombstone). */
  historyGet(
    input: { projectId: number; id: number },
    ctx: ApiContext,
  ): Promise<{ rev: HistoryRevision; content: string | null }>;
  /** Restaura uma revisão (grava o conteúdo de volta; tombstone → apaga). Não-destrutivo. */
  historyRestore(
    input: { projectId: number; id: number },
    ctx: ApiContext,
  ): Promise<{ ok: true; last_modified: string | null; deleted?: true }>;
  /** Rotula uma revisão (a protege da poda automática). */
  historyLabel(input: { projectId: number; id: number; label: string }, ctx: ApiContext): Promise<{ ok: true }>;
}
