import type { ApiContext } from './common.js';

/**
 * Indexer runs (provenance for `IndexProjectUseCase`).
 * Source: apps/http-api/server/routes/runs.ts.
 */

export interface IndexerRun {
  id: number;
  project_id: number;
  started_at: string;
  finished_at: string | null;
  total_files: number;
  indexed_files: number;
  skipped_files: number;
  error_count: number;
  cost_usd: number;
  status: 'running' | 'done' | 'error' | 'aborted';
}

export interface RunsApi {
  list(input: { projectId: number }, ctx: ApiContext): Promise<IndexerRun[]>;
  get(input: { id: number }, ctx: ApiContext): Promise<IndexerRun>;
}
