/**
 * Client for the /api/hygiene routes. The handlers all return a small
 * JSON payload with counters — keep these typed so the panel can render
 * the diff without re-stringifying.
 */
export interface HygieneProject {
  id: number;
  name: string;
  root_path: string;
  file_count: number;
  vector_count: number;
  orphan_semantic_items: number;
  stale_runs: number;
  mixed_case_languages: number;
  missing_on_disk: boolean;
  /** File counts by mapper tier — keys: core/support/on_demand/untagged. */
  tiers: Partial<Record<'core' | 'support' | 'on_demand' | 'untagged', number>>;
}

export interface HygieneStatus {
  projects: HygieneProject[];
  vector_store_available: boolean;
}

export interface CleanupResult {
  ok: boolean;
  orphan_semantic_items: number;
  vectors_deleted_local: number;
  local_deleted: number;
  languages_normalized: number;
  stale_runs_closed: number;
  vector_error: string | null;
}

export interface PurgeSummary {
  project_id: number;
  vectors_known: number;
  vectors_deleted: number;
  vector_error: string | null;
}

export interface SqlSweepResult {
  ok: boolean;
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
  vectors_deleted: number;
  errors: Array<{ project: string; error: string }>;
}

/**
 * Wipe ALL projects' data (index, sessions, snapshots, runs, costs) + local
 * vectors, keeping the project rows so the user only re-indexes. Destructive.
 */
export function clearAllProjectData(): Promise<ClearAllDataResult> {
  return postJson<ClearAllDataResult>('/api/projects/clear-all-data');
}

export interface ClearOneResult {
  ok: boolean;
  vectors_known: number;
  vectors_deleted: number;
  vector_error: string | null;
}

/** Wipe ONE project's data + local vectors, keeping its row. Destructive. */
export function clearProjectData(id: number): Promise<ClearOneResult> {
  return postJson<ClearOneResult>(`/api/projects/${id}/clear-data`);
}
