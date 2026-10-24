/**
 * Migration 180 — `coder_sessions.preflight_seed_json`.
 *
 * Caches the task-preflight seed (the cheap first-prompt pre-analysis result)
 * for a FRESH session so it is computed at most once. `maybeRunPreflight`
 * (http-api) persists the seed here on the first POST and REUSES it on
 * subsequent fresh POSTs — guaranteeing the agent still receives the
 * `<preflight>` hint without paying for the analysis again. Naturally obsolete
 * once the session has its first persisted message (`getMessageCount > 0`).
 *
 * Stored as TEXT (JSON of `PreflightSeed`); NULL when no preflight ran.
 *
 * Mirrors migration 151 (`plan_depth_override`).
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
  // `coder_sessions` ∈ CENTRAL_DROP_TABLES — a per-project DB runs this central
  // migration lineage but trims the table away (see project-db/trim/drop-list.ts).
  // On such a project DB the table is gone when this runs, so guard or the ALTER
  // throws `no such table` and aborts project-DB init. Mirrors migrations 175/177/178.
  if (!tableExists(db, table)) return;
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const sessionPreflightSeed180: Migration = {
  version: 180,
  name: 'session_preflight_seed',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'coder_sessions', 'preflight_seed_json', 'TEXT');
  },
};
