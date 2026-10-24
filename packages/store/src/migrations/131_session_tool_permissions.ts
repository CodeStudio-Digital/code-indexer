/**
 * Migration 131 — per-session tool permission mode on `coder_sessions`.
 *
 * `tool_permission_mode` ('ask' | 'auto' | 'unrestricted', NULL → 'auto')
 * drives the PermissionGate: write/execute/admin-class tools pause and ask
 * the user before executing, depending on the mode. `tool_permission_grants`
 * is a JSON string[] of tool names the user marked "always allow" for this
 * session, so repeated approvals can be skipped.
 *
 * Idempotent (`addColumnIfMissing`) — same repair-friendly pattern as
 * migrations 129/130.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const sessionToolPermissions131: Migration = {
  version: 131,
  name: 'session_tool_permissions',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'coder_sessions', 'tool_permission_mode', 'TEXT');
    addColumnIfMissing(db, 'coder_sessions', 'tool_permission_grants', 'TEXT');
  },
};
