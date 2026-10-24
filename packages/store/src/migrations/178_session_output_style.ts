/**
 * Migration 178 — `coder_sessions.output_style_override`.
 *
 * Per-session sticky output style mirroring Claude Code's selectable response
 * styles: `proactive` (default) | `explanatory` | `learning`. `NULL`/`proactive`
 * → no extra prompt block (the base prompt already biases toward action);
 * `explanatory` adds an educational-insight directive; `learning` adds a
 * single-`TODO(human)` hand-off directive.
 *
 * Feeds the SYSTEM PROMPT (a cache-stable axis above
 * SYSTEM_PROMPT_DYNAMIC_BOUNDARY). Stored as TEXT; the write path
 * (PATCH `/api/coder/sessions/:id/output-style`) validates the enum.
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
  // On a project DB created under an older build (no mig 178 yet), the table is
  // already gone when this runs on upgrade, so guard or the ALTER throws
  // `no such table`. Mirrors the guarded helper in migration 175.
  if (!tableExists(db, table)) return;
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const sessionOutputStyle178: Migration = {
  version: 178,
  name: 'session_output_style',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'coder_sessions', 'output_style_override', 'TEXT');
  },
};
