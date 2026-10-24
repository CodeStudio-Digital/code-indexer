/**
 * Migration 162 — denormalize `project_id` onto `coder_turn_telemetry`.
 *
 * Telemetry/stats stay CENTRAL (faithful platform-wide usage statistics). But
 * the global telemetry summary currently scopes a project via the JOIN
 * `session_id IN (SELECT id FROM coder_sessions WHERE project_id = ?)`. Once the
 * tiered-hybrid split moves `coder_sessions` content into per-project DBs
 * (MCP_PROJECT_DB_SPLIT_SESSIONS), that JOIN breaks because `coder_sessions` no
 * longer lives in the central DB. Carrying `project_id` directly on the
 * telemetry row keeps per-project stats queryable from the central DB alone.
 *
 * Additive + idempotent. Backfills existing rows from the (still-central)
 * `coder_sessions` table; rows whose session is gone stay NULL.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const telemetryProjectId162: Migration = {
  version: 162,
  name: 'telemetry_project_id',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'coder_turn_telemetry', 'project_id', 'INTEGER');

    // Backfill from the central coder_sessions (still central at this point).
    db.exec(`
      UPDATE coder_turn_telemetry
         SET project_id = (
           SELECT s.project_id FROM coder_sessions s WHERE s.id = coder_turn_telemetry.session_id
         )
       WHERE project_id IS NULL AND session_id IS NOT NULL;
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_coder_turn_telemetry_project
        ON coder_turn_telemetry(project_id);
    `);
  },
};
