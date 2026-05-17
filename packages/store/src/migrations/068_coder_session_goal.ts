/**
 * Migration 068 — Persistent session goal.
 *
 * Adds goal-tracking columns to `coder_sessions` so the in-memory `goal`
 * tool (`create_goal` / `get_goal` / `update_goal`) survives runner
 * restarts and dashboard reloads. The goal is the session-wide objective
 * driving the run; lasting longer than `submit_plan` (which is per
 * action) and shorter than the overall project (which is multi-session).
 *
 * Columns are nullable so existing sessions that never set a goal behave
 * exactly as before — `getGoal` returns null and the tool reports "no
 * goal set".
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const coderSessionGoal068: Migration = {
  version: 68,
  name: 'coder_session_goal',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'coder_sessions', 'goal_text', 'TEXT');
    addColumnIfMissing(db, 'coder_sessions', 'goal_status', 'TEXT'); // 'in_progress' | 'complete'
    addColumnIfMissing(db, 'coder_sessions', 'goal_budget_tokens', 'INTEGER');
    addColumnIfMissing(db, 'coder_sessions', 'goal_completion_note', 'TEXT');
    addColumnIfMissing(db, 'coder_sessions', 'goal_created_at', 'TEXT');
    addColumnIfMissing(db, 'coder_sessions', 'goal_updated_at', 'TEXT');
  },
};
