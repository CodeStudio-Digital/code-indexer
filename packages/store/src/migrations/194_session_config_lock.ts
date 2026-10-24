/**
 * Migration 194 — resolved config lock for coder sessions (Codex parity).
 *
 * A session's effective config is reconstructed at resume time from a cascade
 * (global → project → session overrides). Nothing captured the RESOLVED result,
 * so a resume silently ran under a drifted model / reasoning-effort / feature
 * set if the upstream defaults changed. Codex materializes the resolved config
 * into a lock and rejects/warns on replay mismatch — see
 * `.referece/codex/codex-rs/core/src/config_lock.rs`.
 *
 * `session_config_lock_json` stores the JSON snapshot captured at session
 * creation. Nullable: pre-existing sessions have no lock and are simply not
 * drift-checked. TEXT (JSON) — the lock shape evolves in application code, not
 * the schema.
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
  // Project DBs can run the central migration lineage after `coder_sessions`
  // has been trimmed away, so this session-only migration must no-op there.
  if (!tableExists(db, table)) return;
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const sessionConfigLock194: Migration = {
  version: 194,
  name: 'session_config_lock',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'coder_sessions', 'session_config_lock_json', 'TEXT');
  },
};
