/**
 * Client for the /api/hygiene routes. The handlers all return a small
 * JSON payload with counters — keep these typed so the panel can render
 * the diff without re-stringifying.
 */
export interface HygieneProject {
  id: number;
  name: string;
  root_path: string;
  pending_vector_gc: number;
  file_count: number;
  vector_count: number;
  orphan_vector_ids: number;
  stale_runs: number;
  duplicate_vector_ids: number;
  mixed_case_languages: number;
  missing_on_disk: boolean;
  /** File counts by mapper tier — keys: core/support/on_demand/untagged. */
  tiers: Partial<Record<'core' | 'support' | 'on_demand' | 'untagged', number>>;
}

export interface HygieneStatus {
  projects: HygieneProject[];
  pending_vector_deletes: number;
  vector_store_available: boolean;
}

export interface CleanupResult {
  ok: boolean;
  orphan_vectors: number;
  remote_deleted: number;
  local_deleted: number;
  duplicates_removed: number;
  languages_normalized: number;
  stale_runs_closed: number;
  remote_error: string | null;
}

export interface RetryResult {
  ok: boolean;
  attempted: number;
  deleted: number;
  remaining: number;
  remote_error?: string | null;
}

export interface PurgeSummary {
  project_id: number;
  vectors_known: number;
  vectors_deleted_remote: number;
  remote_error: string | null;
}

export interface SqlSweepResult {
  ok: boolean;
  duplicates_removed: number;
  languages_normalized: number;
  stale_runs_closed: number;
}

async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const err = (await r.json().catch(() => ({ error: r.statusText }))) as { error?: string };
    throw new Error(err.error ?? `HTTP ${r.status}`);
  }
  return (await r.json()) as T;
}

export async function fetchHygieneStatus(): Promise<HygieneStatus> {
  const r = await fetch('/api/hygiene/status');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as HygieneStatus;
}

export function cleanupProject(id: number): Promise<CleanupResult> {
  return postJson<CleanupResult>(`/api/hygiene/projects/${id}/cleanup`);
}

export function retryPendingVectorDeletes(): Promise<RetryResult> {
  return postJson<RetryResult>('/api/hygiene/vectorize/retry');
}

export function purgeProjects(projectIds: number[]): Promise<{
  ok: boolean;
  purged: number;
  summaries: PurgeSummary[];
}> {
  return postJson('/api/hygiene/projects/purge', { projectIds, confirm: true });
}

export function runGlobalSqlCleanup(): Promise<SqlSweepResult> {
  return postJson<SqlSweepResult>('/api/hygiene/global/sql-cleanup');
}

export interface ClearAllDataResult {
  ok: boolean;
  projects_cleared: number;
  vectors_deleted_remote: number;
  errors: Array<{ project: string; error: string }>;
}

/**
 * Wipe ALL projects' data (index, sessions, snapshots, runs, costs) + remote
 * vectors, keeping the project rows so the user only re-indexes. Destructive.
 */
export function clearAllProjectData(): Promise<ClearAllDataResult> {
  return postJson<ClearAllDataResult>('/api/projects/clear-all-data');
}

export interface ClearOneResult {
  ok: boolean;
  vectors_known: number;
  vectors_deleted_remote: number;
  remote_error: string | null;
}

/** Wipe ONE project's data + remote vectors, keeping its row. Destructive. */
export function clearProjectData(id: number): Promise<ClearOneResult> {
  return postJson<ClearOneResult>(`/api/projects/${id}/clear-data`);
}
