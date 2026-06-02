import type { ApiContext, AsyncStream } from './common.js';

/**
 * Projects = root unit of work. Each project is bound to a `root_path` on
 * the user's filesystem and owns sessions, files, snapshots, runs.
 *
 * Routes mapped: apps/http-api/server/routes/projects.ts +
 *                apps/http-api/server/routes/stats.ts (per-project stats).
 */

export interface Project {
  id: number;
  name: string;
  root_path: string;
  created_at: string;
  /** Owner — added by the Freemium gating layer (migration 104). */
  user_id?: string;
}

export interface ProjectStats {
  file_count: number;
  symbol_count: number;
  languages: Record<string, number>;
  total_lines: number;
  total_size: number;
  last_indexed: string | null;
  run_count: number;
}

export interface CreateProjectInput {
  name: string;
  root_path: string;
}

export interface UpdateProjectInput {
  name?: string;
  root_path?: string;
  node_version?: string | null;
  runner_shell?: string | null;
}

export interface IndexProjectInput {
  /** Provider id (e.g. 'anthropic', 'openai'). Defaults to the project's pinned provider. */
  provider?: string;
  model?: string;
  /** Force a full re-index instead of incremental. */
  force?: boolean;
}

/**
 * Indexing payloads are passed through as-is from `IndexProjectUseCase`
 * — the dashboard already understands the existing shapes
 * (`IndexStartPayload`, `IndexProgressFrame`, `EmbeddingProgressFrame`,
 * etc. in @mcp/services/services/projects). Typing them here as `unknown`
 * keeps api-bus from coupling to the use-case's evolving frame shape.
 */
export interface IndexResult {
  runId: number;
  totalFiles: number;
  indexedFiles: number;
  skippedFiles: number;
  errorCount: number;
  durationMs: number;
  costUsd: number;
}

export type IndexStreamEvent =
  | { event: 'start'; data: unknown }
  | { event: 'progress'; data: unknown }
  | { event: 'done'; data: IndexResult | unknown }
  | { event: 'error'; data: { message: string } };

export interface ProjectsApi {
  list(input: void, ctx: ApiContext): Promise<Project[]>;
  get(input: { id: number }, ctx: ApiContext): Promise<Project>;
  create(input: CreateProjectInput, ctx: ApiContext): Promise<Project>;
  update(input: { id: number } & UpdateProjectInput, ctx: ApiContext): Promise<Project>;
  delete(
    input: { id: number },
    ctx: ApiContext,
  ): Promise<{ ok: true; vectors_known: number; vectors_deleted_remote: number; remote_error: string | null }>;

  /**
   * Wipe ONE project's data (index, sessions, snapshots, runs, costs) and its
   * remote vectors, KEEPING the project row so the user only re-indexes.
   */
  clearData(
    input: { id: number },
    ctx: ApiContext,
  ): Promise<{ ok: true; vectors_known: number; vectors_deleted_remote: number; remote_error: string | null }>;

  /**
   * Wipe ALL projects' data (index, sessions, snapshots, runs, costs) and their
   * remote vectors, KEEPING each project row so the user only re-indexes — not
   * re-creates. Per-project errors are collected, not fatal.
   */
  clearAllData(
    input: void,
    ctx: ApiContext,
  ): Promise<{
    ok: true;
    projects_cleared: number;
    vectors_deleted_remote: number;
    errors: Array<{ project: string; error: string }>;
  }>;

  stats(input: { id: number }, ctx: ApiContext): Promise<ProjectStats>;

  /** One-shot index (no streaming progress). */
  index(input: { id: number } & IndexProjectInput, ctx: ApiContext): Promise<IndexResult>;

  /** Streaming index — emits IndexStreamEvent per phase/file. */
  indexStream(input: { id: number } & IndexProjectInput, ctx: ApiContext): AsyncStream<IndexStreamEvent>;

  /** Retry embeddings for files that previously failed embedding. */
  retryEmbeddingsStream(input: { id: number }, ctx: ApiContext): AsyncStream<IndexStreamEvent>;
}
