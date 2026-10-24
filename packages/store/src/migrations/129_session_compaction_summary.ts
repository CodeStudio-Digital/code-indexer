/**
 * Migration 129 — repair: ensure `coder_sessions.compaction_summary` exists.
 *
 * Migration 128 adds BOTH `summary_boundary_id` and `compaction_summary`. Dev
 * DBs that ran an earlier single-column iteration of 128 already recorded
 * `schema_version = 128`, so the version-gated runner skips the finalized 128
 * and never adds `compaction_summary` — `setCompactionBoundary` then throws
 * "no such column: compaction_summary".
 *
 * Adds the column idempotently: a no-op on fresh DBs (committed 128 already
 * created it) and on any DB that already has it, so it is safe everywhere.
 * (Never edit 128 itself — applied migrations don't re-run.)
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const sessionCompactionSummary129: Migration = {
  version: 129,
  name: 'session_compaction_summary',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'coder_sessions', 'compaction_summary', 'TEXT');
  },
};
