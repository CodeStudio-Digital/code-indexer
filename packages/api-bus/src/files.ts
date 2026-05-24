import type { ApiContext } from './common.js';

/**
 * Filesystem access scoped to a project's root_path.
 *
 * Read paths use existing routes (apps/http-api/server/routes/files.ts).
 * Write path (`writeFile`) is NEW — added by the IDE workspace (Dia 3
 * of the plan): PUT /api/projects/:id/file. The IDE editor calls this
 * on Ctrl+S.
 */

export interface ProjectFileSummary {
  id: number;
  project_id: number;
  path: string;
  language: string | null;
  loc: number;
  size_bytes: number;
  last_modified: string;
}

export interface FileSymbol {
  id: number;
  name: string;
  kind: string;
  line: number;
  column: number;
}

export interface FileDetail extends ProjectFileSummary {
  symbols: FileSymbol[];
  dependencies: Array<{ from_file: string; to_file: string; kind: string }>;
  dependents: Array<{ from_file: string; to_file: string; kind: string }>;
}

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
  list(input: { projectId: number }, ctx: ApiContext): Promise<ProjectFileSummary[]>;
  manifest(input: { projectId: number }, ctx: ApiContext): Promise<ManifestInfo>;
  get(input: { projectId: number; path: string }, ctx: ApiContext): Promise<FileDetail>;

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

  symbol(input: { id: number }, ctx: ApiContext): Promise<FileSymbol>;
  symbolMembers(input: { id: number }, ctx: ApiContext): Promise<FileSymbol[]>;

  listConcepts(input: { projectId: number }, ctx: ApiContext): Promise<string[]>;
  conceptFiles(input: { projectId: number; concept: string }, ctx: ApiContext): Promise<ProjectFileSummary[]>;
}
