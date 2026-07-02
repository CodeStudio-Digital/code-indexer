/**
 * Migration 188 — service health columns + transition/log tables (company B1).
 *
 * Groundwork for the ServiceSupervisor: today a sandbox service only has a
 * coarse `status` lifecycle (provisioning→running→…) with no notion of
 * "the container is up but the dev server inside it is dead", no audit
 * trail of WHY a service flipped state, and no persisted output to debug
 * a crash after the fact.
 *
 * Three additions:
 *   - `company_sandbox_services.health` (+detail/timestamp/restart_count):
 *     liveness as observed by the supervisor probe. TEXT without CHECK on
 *     purpose — probe vocabularies will evolve ('unknown' is the seed).
 *   - `company_service_transitions`: append-only audit of status/health
 *     flips (who flipped it, from what, to what, why).
 *   - `company_service_logs`: ring-buffered service output, one row per
 *     line, tagged by stream (devserver|container|scaffold). The store
 *     trims to a per-service cap; the DB does not enforce it.
 *
 * Both new tables key `(session_id, service_id)` WITHOUT a foreign key to
 * `company_sandbox_services` — service rows are routinely destroyed and
 * re-provisioned under the same service_id, and the history must survive
 * that. Cleanup is explicit via the store's purge APIs.
 *
 * `company_sandbox_services` is in CENTRAL_DROP_TABLES (project-DB trim),
 * so every ALTER is guarded with tableExists — see the convention note in
 * project-db/trim/drop-list.ts and migration 175.
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
  if (!tableExists(db, table)) return;
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const serviceHealthTransitionsLogs188: Migration = {
  version: 188,
  name: 'service_health_transitions_logs',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'company_sandbox_services', 'health', "TEXT NOT NULL DEFAULT 'unknown'");
    addColumnIfMissing(db, 'company_sandbox_services', 'health_detail', 'TEXT');
    addColumnIfMissing(db, 'company_sandbox_services', 'last_health_at_ms', 'INTEGER');
    addColumnIfMissing(db, 'company_sandbox_services', 'restart_count', 'INTEGER NOT NULL DEFAULT 0');

    db.exec(`
      CREATE TABLE IF NOT EXISTS company_service_transitions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  INTEGER NOT NULL,
        service_id  TEXT NOT NULL,
        kind        TEXT NOT NULL CHECK(kind IN ('status','health')),
        from_state  TEXT,
        to_state    TEXT NOT NULL,
        reason      TEXT,
        actor       TEXT NOT NULL,
        at_ms       INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_company_service_transitions_session
        ON company_service_transitions(session_id, service_id, at_ms DESC);

      CREATE TABLE IF NOT EXISTS company_service_logs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  INTEGER NOT NULL,
        service_id  TEXT NOT NULL,
        stream      TEXT NOT NULL CHECK(stream IN ('devserver','container','scaffold')),
        line        TEXT NOT NULL,
        at_ms       INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_company_service_logs_session
        ON company_service_logs(session_id, service_id, id);
    `);
  },
};
