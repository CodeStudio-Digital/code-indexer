/**
 * Migration 189 — QA run progress + machine-readable error class (company B1).
 *
 * Three columns on `qa_test_runs`:
 *   - `error_class`: coarse machine-readable failure class, NULL on
 *     success. TEXT without CHECK on purpose (values will evolve with the
 *     QA sidecar); documented vocabulary today:
 *       orphan | sidecar_down | reporter_unreachable | config_invalid |
 *       driver_error | aborted
 *   - `last_event_at`: ISO timestamp of the last reporter event received
 *     for the run. Lets the supervisor tell "slow suite" from "reporter
 *     went silent" (orphan detection) without scanning qa_test_results.
 *   - `plan_gate`: how the run cleared the plan gate — approved (human
 *     ok'd the plan) | auto (gate disabled/auto-approved) | skipped (run
 *     path without a gate, e.g. watcher re-runs). NULL on legacy rows.
 *
 * `qa_test_runs` is in CENTRAL_DROP_TABLES (project-DB trim), so the
 * ALTERs are guarded with tableExists — see project-db/trim/drop-list.ts
 * and migration 175. Follow-ups to this table ride NEW migrations (the
 * runner is version-gated; see migration 060's note).
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function tableExists(db: DB, table: string): boolean {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(table);
}

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  if (!tableExists(db, table)) return;
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const qaRunProgressAndErrorClass189: Migration = {
  version: 189,
  name: 'qa_run_progress_and_error_class',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'qa_test_runs', 'error_class', 'TEXT');
    addColumnIfMissing(db, 'qa_test_runs', 'last_event_at', 'TEXT');
    addColumnIfMissing(db, 'qa_test_runs', 'plan_gate', 'TEXT');
  },
};
