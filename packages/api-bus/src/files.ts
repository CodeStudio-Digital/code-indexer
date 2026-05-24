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
}

export interface FilesApi {
  list(input: { projectId: number }, ctx: ApiContext): Promise<unknown[]>;
  manifest(input: { projectId: number }, ctx: ApiContext): Promise<ManifestInfo>;
  get(input: { projectId: number; path: string }, ctx: ApiContext): Promise<unknown>;

  /** Raw read of file contents from disk (used by the Monaco editor). */
  read(input: { projectId: number; path: string }, ctx: ApiContext): Promise<{ content: string; encoding: 'utf8' | 'base64' }>;

  /**
   * Persist editor content to disk. Returns the new on-disk mtime so the
   * client can compare with its in-memory dirty state.
   */
  write(
    input: { projectId: number; path: string; content: string; encoding?: 'utf8' | 'base64' },
    ctx: ApiContext,
  ): Promise<{ ok: true; last_modified: string }>;

  /** Recursive file tree for the IDE sidebar. */
  tree(input: { projectId: number; maxDepth?: number; root?: string }, ctx: ApiContext): Promise<FileTreeNode>;

  symbol(input: { id: number }, ctx: ApiContext): Promise<unknown>;
  symbolMembers(input: { id: number }, ctx: ApiContext): Promise<unknown[]>;

  listConcepts(input: { projectId: number }, ctx: ApiContext): Promise<Array<{ concept: string; count: number }>>;
  conceptFiles(input: { projectId: number; concept: string }, ctx: ApiContext): Promise<unknown[]>;
}
