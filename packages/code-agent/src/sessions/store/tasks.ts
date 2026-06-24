import type { Database as DB } from 'better-sqlite3';
import type {
  CoderTask,
  CoderTasksRow,
  TaskExecutionMode,
  TasksState,
} from '@mcp/code-agent/sessions/types.js';

export interface RecordTasksInput {
  session_id: number;
  tool_use_id: string;
  state: TasksState;
}

/**
 * Persist a fresh submit_tasks call. UPSERT keyed by session_id — one task
 * list per session at a time.
 *
 * MERGE BEHAVIOR: when a previous task list exists, runtime state for tasks
 * whose `id` survives the re-submission is preserved — `status`, `mode_used`,
 * `started_at`, `finished_at`, and `result`. Plan-time fields (title,
 * description, files, references, depends_on, suggested_mode,
 * estimated_complexity) are taken from the new submission so the agent can
 * refine the plan. Tasks that disappear from the new list are dropped; tasks
 * with a new id enter as plain `pending`.
 *
 * If the agent wants a true reset, it can use entirely new ids — none match,
 * nothing is preserved.
 */
export function record(db: DB, input: RecordTasksInput): CoderTasksRow {
  const previous = getState(db, input.session_id);
  let mergedState: TasksState = input.state;
  // Track-gate writes (the lightweight checklist) are authoritative full
  // replacements — the agent sets each item's status explicitly via
  // task_list/todo_write, so we must NOT preserve prior runtime status the way
  // the approve flow does. Skip the merge entirely for track lists.
  const isTrackWrite = input.state.gate === 'track';
  if (!isTrackWrite && previous && previous.tasks.length > 0) {
    const prevById = new Map(previous.tasks.map((t) => [t.id, t]));
    const mergedTasks: CoderTask[] = input.state.tasks.map((incoming) => {
      const prior = prevById.get(incoming.id);
      if (!prior) return incoming;
      // Preserve runtime/lifecycle fields from prior; take plan-time from incoming.
      return {
        ...incoming,
        status: prior.status,
        mode_used: prior.mode_used,
        started_at: prior.started_at,
        finished_at: prior.finished_at,
        result: prior.result,
      };
    });
    // Preserve current_task_id only if that id still exists in the new list.
    const survivedCurrent = previous.current_task_id && mergedTasks.some((t) => t.id === previous.current_task_id)
      ? previous.current_task_id
      : null;
    mergedState = { ...input.state, tasks: mergedTasks, current_task_id: survivedCurrent };
  }
  const json = JSON.stringify(mergedState);
  db.prepare(`
    INSERT INTO coder_tasks_state (session_id, tool_use_id, state, version, created_at, updated_at)
    VALUES (?, ?, ?, 1, datetime('now'), datetime('now'))
    ON CONFLICT(session_id) DO UPDATE SET
      tool_use_id = excluded.tool_use_id,
      state = excluded.state,
      version = 1,
      updated_at = datetime('now')
  `).run(input.session_id, input.tool_use_id, json);
  return db.prepare('SELECT * FROM coder_tasks_state WHERE session_id = ?')
    .get(input.session_id) as CoderTasksRow;
}

/**
 * Apply the user's verdict on a pending task list. Merges any user-edited
 * tasks back into the persisted state, sets execution_mode + approved.
 * Bumps version monotonically.
 */
export function resolve(
  db: DB, sessionId: number,
  verdict: { approved: boolean; tasks?: CoderTask[]; execution_mode?: TaskExecutionMode | null },
): TasksState | null {
  const current = getState(db, sessionId);
  if (!current) return null;
  const next: TasksState = {
    ...current,
    tasks: verdict.tasks ?? current.tasks,
    execution_mode: verdict.execution_mode ?? current.execution_mode,
    approved: verdict.approved,
  };
  db.prepare(`
    UPDATE coder_tasks_state
       SET state = ?, version = version + 1, updated_at = datetime('now')
     WHERE session_id = ?
  `).run(JSON.stringify(next), sessionId);
  return next;
}

/**
 * Surgical update of a single task's runtime fields (status, started_at,
 * finished_at, result, mode_used). Re-serializes the whole state — fine
 * because the JSON is small (kilobytes) and updates are infrequent.
 */
export function updateStatus(db: DB, sessionId: number, taskId: string, patch: Partial<CoderTask>): TasksState | null {
  const current = getState(db, sessionId);
  if (!current) return null;
  const idx = current.tasks.findIndex((t) => t.id === taskId);
  if (idx < 0) return null;
  const merged: CoderTask = { ...current.tasks[idx], ...patch };
  const next: TasksState = {
    ...current,
    tasks: current.tasks.map((t, i) => (i === idx ? merged : t)),
    current_task_id: patch.status === 'running'
      ? taskId
      : (patch.status === 'done' || patch.status === 'failed' || patch.status === 'skipped') && current.current_task_id === taskId
        ? null
        : current.current_task_id,
  };
  db.prepare(`
    UPDATE coder_tasks_state
       SET state = ?, version = version + 1, updated_at = datetime('now')
     WHERE session_id = ?
  `).run(JSON.stringify(next), sessionId);
  return next;
}

export function getState(db: DB, sessionId: number): TasksState | null {
  const row = db.prepare('SELECT * FROM coder_tasks_state WHERE session_id = ?').get(sessionId) as CoderTasksRow | undefined;
  if (!row) return null;
  try { return JSON.parse(row.state) as TasksState; }
  catch { return null; }
}

export function clear(db: DB, sessionId: number): boolean {
  const result = db.prepare('DELETE FROM coder_tasks_state WHERE session_id = ?').run(sessionId);
  return result.changes > 0;
}

/**
 * On session resume, any task stuck in 'running' is an orphan — the previous
 * runner died before it could finish. Reset to 'interrupted' so `execute_task`
 * can retry. Returns the number of tasks recovered (0 if nothing changed).
 */
export function recoverStale(db: DB, sessionId: number): number {
  const current = getState(db, sessionId);
  if (!current) return 0;
  // Track-gate checklists have no orphaned execute_task/subagent scope to
  // recover — a 'running' item is just the in_progress UI marker. Skip them so
  // they aren't flipped to 'interrupted' (which deriveTodosFromState reads back
  // as 'pending', silently losing the marker on every turn-end/resume). Inline
  // gate check (no effectiveGate import) keeps the store a leaf — matches the
  // isTrackWrite check in record().
  if ((current.gate ?? 'approve') === 'track') return 0;
  let recovered = 0;
  const tasks = current.tasks.map((t) => {
    if (t.status === 'running') {
      recovered++;
      return { ...t, status: 'interrupted' as const, finished_at: new Date().toISOString() };
    }
    return t;
  });
  if (recovered === 0) return 0;
  const next: TasksState = { ...current, tasks, current_task_id: null };
  db.prepare(`
    UPDATE coder_tasks_state
       SET state = ?, version = version + 1, updated_at = datetime('now')
     WHERE session_id = ?
  `).run(JSON.stringify(next), sessionId);
  console.log(`[coder] recoverStaleTasks: session ${sessionId} — recovered ${recovered} stuck task(s)`);
  return recovered;
}

export function getRow(db: DB, sessionId: number): CoderTasksRow | null {
  const row = db.prepare('SELECT * FROM coder_tasks_state WHERE session_id = ?').get(sessionId) as CoderTasksRow | undefined;
  return row ?? null;
}
