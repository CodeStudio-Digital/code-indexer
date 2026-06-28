/**
 * Migration 177 — response-language directive.
 *
 * Adds two columns:
 *   - `coder_sessions.response_language_override` (TEXT) — per-session sticky
 *     language for the agent's user-facing replies (e.g. "Português (Brasil)",
 *     "English"). `NULL`/`"auto"` → the runner falls back to the project default
 *     and then to the neutral "respond in the user's language" directive.
 *   - `projects.default_response_language` (TEXT) — per-project default that
 *     seeds the resolution when a session has no explicit override.
 *
 * The value feeds the SYSTEM PROMPT (`# Language` block, a cache-stable axis
 * above SYSTEM_PROMPT_DYNAMIC_BOUNDARY). Stored as free-form TEXT; the write
 * path (PATCH `/api/coder/sessions/:id/response-language`) trims and bounds it.
 *
 * Mirrors migration 151 (`plan_depth_override`).
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function tableExists(db: DB, table: string): boolean {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(table);
}

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  // `coder_sessions` ∈ CENTRAL_DROP_TABLES — a per-project DB runs this central
  // migration lineage but trims the table away (see project-db/trim/drop-list.ts).
  // On a project DB created under an older build (no mig 177 yet), the table is
  // already gone when this runs on upgrade, so guard per-table or the ALTER throws
  // `no such table`. `projects` is kept, so it still gets its column. Mirrors mig 175.
  if (!tableExists(db, table)) return;
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const sessionResponseLanguage177: Migration = {
  version: 177,
  name: 'session_response_language',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'coder_sessions', 'response_language_override', 'TEXT');
    addColumnIfMissing(db, 'projects', 'default_response_language', 'TEXT');
  },
};
