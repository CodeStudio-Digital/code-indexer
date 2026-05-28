/**
 * Persistence for `execute_tasks` runs (PR-B, migration 108).
 *
 * One row per invocation in `coder_task_runs` + one row per task ATTEMPT
 * in `coder_task_run_items`. The orchestrator writes through synchronously
 * — better-sqlite3 inserts run in ~50µs so this is not a hot-path concern.
 *
 * Recovery: on worker boot, `recoverRunningRuns()` promotes any run/item
 * stuck in `status='running'` to `aborted` with `reject_reason='worker_restart'`.
 * Matches the pattern used by `coder_tasks_state.recoverStale`.
 */
import type { Database as DB } from 'better-sqlite3';
import type { TaskKind, TaskStatus } from '@mcp/code-agent/sessions/types.js';

// ─── Row shapes ─────────────────────────────────────────────────

export type TaskRunStatus = 'running' | 'completed' | 'failed' | 'aborted';

export interface TaskRunRow {
  run_id: string;
  session_id: number;
  mode: 'auto' | 'inline-all';
  started_at: string;
  finished_at: string | null;
  status: TaskRunStatus;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  budget_tokens: number | null;
  budget_usd_cents: number | null;
  reject_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskRunItemRow {
  run_id: string;
  task_id: string;
  attempt: number;
  wave_idx: number;
  parallel_group: string | null;
  kind: TaskKind;
  title: string;
  started_at: string | null;
  finished_at: string | null;
  status: TaskStatus;
  tool_call_count: number;
  input_tokens: number;
  output_tokens: number;
  inputs_fingerprint: string | null;
  skip_reason: string | null;
  error: string | null;
  summary: string | null;
}

// ─── CREATE / UPDATE ────────────────────────────────────────────

export interface CreateTaskRunInput {
  run_id: string;
  session_id: number;
  mode: 'auto' | 'inline-all';
  started_at: string;
  budget_tokens?: number | null;
  budget_usd_cents?: number | null;
}

export function createRun(db: DB, input: CreateTaskRunInput): void {
  db.prepare(`
    INSERT INTO coder_task_runs
      (run_id, session_id, mode, started_at, status, budget_tokens, budget_usd_cents)
    VALUES (?, ?, ?, ?, 'running', ?, ?)
  `).run(
    input.run_id,
    input.session_id,
    input.mode,
    input.started_at,
    input.budget_tokens ?? null,
    input.budget_usd_cents ?? null,
  );
}

export interface UpdateRunPatch {
  status?: TaskRunStatus;
  finished_at?: string | null;
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_cache_read_tokens?: number;
  total_cache_creation_tokens?: number;
  reject_reason?: string | null;
}

export function updateRun(db: DB, runId: string, patch: UpdateRunPatch): void {
  const sets: string[] = ["updated_at = datetime('now')"];
  const values: unknown[] = [];
  if (patch.status !== undefined) { sets.push('status = ?'); values.push(patch.status); }
  if (patch.finished_at !== undefined) { sets.push('finished_at = ?'); values.push(patch.finished_at); }
  if (patch.total_input_tokens !== undefined) { sets.push('total_input_tokens = ?'); values.push(patch.total_input_tokens); }
  if (patch.total_output_tokens !== undefined) { sets.push('total_output_tokens = ?'); values.push(patch.total_output_tokens); }
  if (patch.total_cache_read_tokens !== undefined) { sets.push('total_cache_read_tokens = ?'); values.push(patch.total_cache_read_tokens); }
  if (patch.total_cache_creation_tokens !== undefined) { sets.push('total_cache_creation_tokens = ?'); values.push(patch.total_cache_creation_tokens); }
  if (patch.reject_reason !== undefined) { sets.push('reject_reason = ?'); values.push(patch.reject_reason); }
  if (sets.length === 1) return; // only timestamp would change — skip
  values.push(runId);
  db.prepare(`UPDATE coder_task_runs SET ${sets.join(', ')} WHERE run_id = ?`).run(...values);
}

export interface UpsertItemInput {
  run_id: string;
  task_id: string;
  attempt?: number;
  wave_idx: number;
  parallel_group?: string | null;
  kind: TaskKind;
  title: string;
  started_at?: string | null;
  finished_at?: string | null;
  status: TaskStatus;
  tool_call_count?: number;
  input_tokens?: number;
  output_tokens?: number;
  inputs_fingerprint?: string | null;
  skip_reason?: string | null;
  error?: string | null;
  summary?: string | null;
}

export function upsertItem(db: DB, input: UpsertItemInput): void {
  db.prepare(`
    INSERT INTO coder_task_run_items
      (run_id, task_id, attempt, wave_idx, parallel_group, kind, title,
       started_at, finished_at, status, tool_call_count,
       input_tokens, output_tokens, inputs_fingerprint, skip_reason, error, summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id, task_id, attempt) DO UPDATE SET
      wave_idx = excluded.wave_idx,
      parallel_group = excluded.parallel_group,
      kind = excluded.kind,
      title = excluded.title,
      started_at = COALESCE(excluded.started_at, coder_task_run_items.started_at),
      finished_at = COALESCE(excluded.finished_at, coder_task_run_items.finished_at),
      status = excluded.status,
      tool_call_count = excluded.tool_call_count,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      inputs_fingerprint = COALESCE(excluded.inputs_fingerprint, coder_task_run_items.inputs_fingerprint),
      skip_reason = COALESCE(excluded.skip_reason, coder_task_run_items.skip_reason),
      error = COALESCE(excluded.error, coder_task_run_items.error),
      summary = COALESCE(excluded.summary, coder_task_run_items.summary),
      updated_at = datetime('now')
  `).run(
    input.run_id, input.task_id, input.attempt ?? 0, input.wave_idx,
    input.parallel_group ?? null, input.kind, input.title,
    input.started_at ?? null, input.finished_at ?? null, input.status,
    input.tool_call_count ?? 0,
    input.input_tokens ?? 0, input.output_tokens ?? 0,
    input.inputs_fingerprint ?? null, input.skip_reason ?? null,
    input.error ?? null, input.summary ?? null,
  );
}

// ─── READ ───────────────────────────────────────────────────────

export function getRun(db: DB, runId: string): TaskRunRow | null {
  const row = db.prepare('SELECT * FROM coder_task_runs WHERE run_id = ?').get(runId) as TaskRunRow | undefined;
  return row ?? null;
}

export function listRunsBySession(db: DB, sessionId: number, limit = 25): TaskRunRow[] {
  return db.prepare(`
    SELECT * FROM coder_task_runs
     WHERE session_id = ?
     ORDER BY started_at DESC
     LIMIT ?
  `).all(sessionId, limit) as TaskRunRow[];
}

export function listItems(db: DB, runId: string): TaskRunItemRow[] {
  return db.prepare(`
    SELECT * FROM coder_task_run_items
     WHERE run_id = ?
     ORDER BY wave_idx ASC, started_at ASC, attempt ASC
  `).all(runId) as TaskRunItemRow[];
}

export function getRunWithItems(db: DB, runId: string): { run: TaskRunRow; items: TaskRunItemRow[] } | null {
  const run = getRun(db, runId);
  if (!run) return null;
  return { run, items: listItems(db, runId) };
}

/**
 * Find the most-recent successful attempt of `task_id` across all runs
 * (PR-D skip-stale check). Returns the row when status='done' AND a
 * fingerprint is present; null otherwise. Used by `shouldSkipTask` to
 * compare current inputs against the last known-good fingerprint.
 */
export function findLastCompletedItem(db: DB, taskId: string): TaskRunItemRow | null {
  const row = db.prepare(`
    SELECT * FROM coder_task_run_items
     WHERE task_id = ?
       AND status = 'done'
       AND inputs_fingerprint IS NOT NULL
     ORDER BY finished_at DESC
     LIMIT 1
  `).get(taskId) as TaskRunItemRow | undefined;
  return row ?? null;
}

// ─── RECOVERY (boot-time) ───────────────────────────────────────

/**
 * Promote any run/item stuck in `running` (worker died mid-execute_tasks)
 * to `aborted` + `reject_reason='worker_restart'`. Idempotent — safe to
 * call on every boot. Returns the number of runs touched (items follow).
 */
export function recoverRunningRuns(db: DB, sessionId?: number): number {
  const now = new Date().toISOString();
  const reason = 'worker_restart';
  const runs = (sessionId == null
    ? db.prepare("SELECT run_id FROM coder_task_runs WHERE status = 'running'").all()
    : db.prepare("SELECT run_id FROM coder_task_runs WHERE status = 'running' AND session_id = ?").all(sessionId)
  ) as { run_id: string }[];
  if (runs.length === 0) return 0;

  const updateRunStmt = db.prepare(`
    UPDATE coder_task_runs
       SET status = 'aborted', finished_at = ?, reject_reason = ?, updated_at = datetime('now')
     WHERE run_id = ? AND status = 'running'
  `);
  const updateItemsStmt = db.prepare(`
    UPDATE coder_task_run_items
       SET status = 'interrupted', finished_at = ?, error = ?, updated_at = datetime('now')
     WHERE run_id = ? AND status = 'running'
  `);
  const tx = db.transaction((runIds: string[]) => {
    for (const id of runIds) {
      updateRunStmt.run(now, reason, id);
      updateItemsStmt.run(now, reason, id);
    }
  });
  tx(runs.map((r) => r.run_id));
  console.log(
    `[coder/task-runs] recoverRunningRuns: ${runs.length} run(s) promoted to aborted` +
    (sessionId == null ? '' : ` for session=${sessionId}`),
  );
  return runs.length;
}
