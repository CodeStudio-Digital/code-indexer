/**
 * Migration 057 — `coder_sessions.temperature_override`.
 *
 * Per-session manual temperature override. When NULL, the runner falls
 * through to the company role override, then to the agent preset's
 * `defaultTemperature`, then to the global default. See
 * `src/core/coder/inference/temperature.ts::resolveTemperature` for the full
 * precedence chain.
 *
 * Stored as REAL (SQLite) so callers can persist any value in [0, 1] without
 * losing precision. The resolver clamps so out-of-range values from the UI or
 * direct SQL writes can't break a request.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const sessionTemperature057: Migration = {
  version: 57,
  name: 'session_temperature',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'coder_sessions', 'temperature_override', 'REAL');
  },
};
