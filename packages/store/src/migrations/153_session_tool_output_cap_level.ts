/**
 * Migration 153 — `coder_sessions.tool_output_cap_level`.
 *
 * Per-session sticky tool-output cap LEVEL: `economic` | `medium` | `high` |
 * `extra` | `max` | `ultra`. Supersedes the legacy binary
 * `unrestricted_tool_output` (mig 078) toggle — instead of on/off it scales the
 * per-tool-call truncation caps proportionally (economic = 24k base on the main
 * runner → ultra ≈ 4 MB). When NULL, the runner derives the level from the
 * legacy boolean (1 → 'max', else 'economic'), so existing sessions keep
 * working. Stored as TEXT; validation lives at the write path
 * (PATCH `/api/coder/sessions/:id/tool-output-cap-level`).
 *
 * Mirrors migration 150/151 (idempotent forward column add).
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const sessionToolOutputCapLevel153: Migration = {
  version: 153,
  name: 'session_tool_output_cap_level',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'coder_sessions', 'tool_output_cap_level', 'TEXT');
  },
};
