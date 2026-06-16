/**
 * Migration 152 — Global (multi-project) coder sessions.
 *
 * A "global session" is a normal `coder_sessions` row that is NOT bound to a
 * single project: the user links 1+ projects and one agent works across all of
 * them. The session's `project_id` stays NOT NULL and is the PRIMARY project
 * (the native cwd); the additional links live in a junction table mirroring
 * `company_session_projects` (migration 018).
 *
 * Two additions, both forward-idempotent and zero-impact on existing rows:
 *   - `coder_sessions.is_global` (default 0) — every pre-existing session is
 *     non-global, so the per-project session list (which now filters
 *     `is_global = 0`) keeps showing them and the runner's multi-bridge path
 *     never triggers for them.
 *   - `coder_session_projects` — junction of (session, project). The primary
 *     project is stored here too with `is_primary = 1` so the runner reads a
 *     single table to discover all linked roots. No `ON DELETE CASCADE` toward
 *     `projects` (mirrors company): deleting a project is cleaned up lazily via
 *     `pruneOrphans` on read, never silently breaking a session.
 *
 * The `is_global` flag is required (not derivable from "has junction rows"): a
 * global session linked to a single project would otherwise be indistinguishable
 * from a normal one, and the per-project list needs an indexed predicate to
 * exclude globals cheaply.
 *
 * Mirrors migration 018 (`company_session_projects`).
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const globalSessions152: Migration = {
  version: 152,
  name: 'global_sessions',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'coder_sessions', 'is_global', 'INTEGER NOT NULL DEFAULT 0');

    db.exec(`
      CREATE TABLE IF NOT EXISTS coder_session_projects (
        coder_session_id INTEGER NOT NULL REFERENCES coder_sessions(id) ON DELETE CASCADE,
        project_id       INTEGER NOT NULL,
        label            TEXT,
        is_primary       INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (coder_session_id, project_id)
      );
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_csp_session
        ON coder_session_projects(coder_session_id);
    `);

    // Partial index: backs both the "list global sessions" scan and the
    // "exclude globals from a project's list" predicate without bloating the
    // common non-global path.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_coder_sessions_global
        ON coder_sessions(is_global) WHERE is_global = 1;
    `);
  },
};
