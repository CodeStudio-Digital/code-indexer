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
  total_lines: number;
  run_count: number;
}

export interface CreateProjectInput {
  name: string;
  root_path: string;
}

export interface UpdateProjectInput {
  name?: string;
  root_path?: string;
}

export interface IndexProjectInput {
  /** Provider id (e.g. 'anthropic', 'openai'). Defaults to the project's pinned provider. */
  provider?: string;
  model?: string;
  /** Force a full re-index instead of incremental. */
  force?: boolean;
}

export interface IndexProgress {
  phase: 'discovering' | 'parsing' | 'embedding' | 'writing';
  total: number;
  done: number;
  current_file?: string;
}

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
  | { event: 'start'; data: IndexProgress }
  | { event: 'progress'; data: IndexProgress }
  | { event: 'done'; data: IndexResult }
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

  stats(input: { id: number }, ctx: ApiContext): Promise<ProjectStats>;

  /** One-shot index (no streaming progress). */
  index(input: { id: number } & IndexProjectInput, ctx: ApiContext): Promise<IndexResult>;

  /** Streaming index — emits IndexStreamEvent per phase/file. */
  indexStream(input: { id: number } & IndexProjectInput, ctx: ApiContext): AsyncStream<IndexStreamEvent>;

  /** Retry embeddings for files that previously failed embedding. */
  retryEmbeddingsStream(input: { id: number }, ctx: ApiContext): AsyncStream<IndexStreamEvent>;
}
