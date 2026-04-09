/**
 * Migration 013 — Coder lightweight todos + worktree tracking.
 *
 * Adds two additive columns to `coder_sessions`:
 *   - todos_json    : serialized lightweight checklist maintained by the
 *                     `todo_write` tool. Distinct from the heavyweight
 *                     `submit_tasks` flow (see migration 008). Persisted so
 *                     a dashboard reload rehydrates the sidebar state.
 *   - worktree_path : absolute path of the git worktree this session is
 *                     currently scoped to, if any. Set by `enter_worktree`,
 *                     cleared by `exit_worktree`. Used on session resume to
 *                     restore the runner's cwd to the worktree it was in.
 *
 * Both are nullable TEXT (JSON / path string), defaulting to NULL. Existing
 * sessions behave exactly as before.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const coderTodosAndWorktree013: Migration = {
  version: 13,
  name: 'coder_todos_and_worktree',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'coder_sessions', 'todos_json', 'TEXT');
    addColumnIfMissing(db, 'coder_sessions', 'worktree_path', 'TEXT');
  },
};
