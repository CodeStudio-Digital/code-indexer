/**
 * Migration 060 — Backfill `qa_test_runs.last_error`.
 *
 * Migration 047 was edited after it had already been applied to some
 * databases — its earlier form did not include
 * `ALTER TABLE qa_test_runs ADD COLUMN last_error TEXT`. Once
 * `schema_version` records 47 as applied, the runner skips it on
 * subsequent boots, so the column never lands.
 *
 * Symptom from the field: `QaTestRunStore.countWatchdogKills` runs
 * `... AND last_error IS NOT NULL ...` and crashes with
 * `SqliteError: no such column: last_error`.
 *
 * This migration is idempotent — it only adds the column when missing,
 * so running it on an up-to-date DB is a no-op. Future column changes
 * to qa_test_runs should ride a fresh migration instead of editing
 * historical ones.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const qaTestRunsLastErrorBackfill060: Migration = {
  version: 60,
  name: 'qa_test_runs_last_error_backfill',
  up(db: DB) {
    addColumnIfMissing(db, 'qa_test_runs', 'last_error', 'TEXT');
  },
};
