import type { Database as DB } from 'better-sqlite3';

export interface SessionGoal {
  text: string;
  status: 'in_progress' | 'complete';
  budgetTokens: number | null;
  completionNote: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Read the current goal for a session, or null when none was ever set AND
 * when the migration columns are absent (older sqlite files).
 */
export function get(db: DB, id: number): SessionGoal | null {
  let row: {
    goal_text: string | null;
    goal_status: string | null;
    goal_budget_tokens: number | null;
    goal_completion_note: string | null;
    goal_created_at: string | null;
    goal_updated_at: string | null;
  } | undefined;
  try {
    row = db
      .prepare(
        'SELECT goal_text, goal_status, goal_budget_tokens, goal_completion_note, goal_created_at, goal_updated_at ' +
        'FROM coder_sessions WHERE id = ?',
      )
      .get(id) as typeof row;
  } catch {
    return null; // table missing migration — degrade gracefully
  }
  if (!row || !row.goal_text || !row.goal_status) return null;
  return {
    text: row.goal_text,
    status: row.goal_status === 'complete' ? 'complete' : 'in_progress',
    budgetTokens: row.goal_budget_tokens,
    completionNote: row.goal_completion_note,
    createdAt: row.goal_created_at ?? '',
    updatedAt: row.goal_updated_at ?? row.goal_created_at ?? '',
  };
}

export interface UpsertGoalInput {
  text: string;
  status: 'in_progress' | 'complete';
  budgetTokens?: number | null;
  completionNote?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Persist or replace the goal for a session. The runCoder wiring funnels
 * `create_goal` / `update_goal` here so the goal survives runner death and
 * shows up after a dashboard reload.
 */
export function upsert(db: DB, id: number, goal: UpsertGoalInput): void {
  try {
    db
      .prepare(
        'UPDATE coder_sessions SET ' +
        'goal_text = ?, goal_status = ?, goal_budget_tokens = ?, goal_completion_note = ?, ' +
        "goal_created_at = ?, goal_updated_at = ?, updated_at = datetime('now') " +
        'WHERE id = ?',
      )
      .run(
        goal.text, goal.status, goal.budgetTokens ?? null, goal.completionNote ?? null,
        goal.createdAt, goal.updatedAt, id,
      );
  } catch (e) {
    // Older db without migration 068 — log and let the in-memory fallback
    // in goal.ts keep things working for the live runner.
    console.warn(`[session-store] upsertSessionGoal failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Clear the goal for a session (used by tests, never by the tool itself). */
export function clear(db: DB, id: number): void {
  try {
    db
      .prepare(
        'UPDATE coder_sessions SET goal_text = NULL, goal_status = NULL, goal_budget_tokens = NULL, ' +
        'goal_completion_note = NULL, goal_created_at = NULL, goal_updated_at = NULL, ' +
        "updated_at = datetime('now') WHERE id = ?",
      )
      .run(id);
  } catch {
    /* ignore */
  }
}
