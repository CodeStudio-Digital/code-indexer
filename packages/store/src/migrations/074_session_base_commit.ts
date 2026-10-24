/**
 * Migration 074 — base_commit_sha on coder_sessions for Reviewer (Camada 4).
 *
 * The Reviewer subagent needs to know "what changed since the session
 * started" so it can review only the diff, not re-read the whole repo.
 * We capture HEAD at session creation as `base_commit_sha`; the reviewer
 * runs `git diff <base>...HEAD` to get the change set.
 *
 * Nullable because:
 *   - sessions on non-git projects keep working (reviewer skips with a hint)
 *   - existing sessions get NULL until a fresh `git rev-parse HEAD` runs
 *
 * `last_review_at` records when the most recent review subagent finished —
 * the trigger heuristic uses it to avoid re-running on every turn.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function columnExists(db: DB, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((r) => r.name === column);
}

export const sessionBaseCommit074: Migration = {
  version: 74,
  name: 'session_base_commit',
  up: (db: DB): void => {
    if (!columnExists(db, 'coder_sessions', 'base_commit_sha')) {
      db.exec(`ALTER TABLE coder_sessions ADD COLUMN base_commit_sha TEXT`);
    }
    if (!columnExists(db, 'coder_sessions', 'last_review_at')) {
      db.exec(`ALTER TABLE coder_sessions ADD COLUMN last_review_at TEXT`);
    }
  },
};
