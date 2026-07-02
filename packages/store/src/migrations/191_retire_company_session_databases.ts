/**
 * Migration 191 — retire the session-scoped database registry.
 *
 * The company "Databases" feature (migration 040) stored typed pointers in
 * `company_session_databases` and the actual connection strings as PLAINTEXT
 * rows in `company_session_envs` (keys recorded per-field in `env_keys_json`).
 * It is replaced by the project-scoped Databases tab (migration 174), whose
 * connections the `db_*` v2 agent tools + the read-only company panel read.
 *
 * Steps (all guarded — project DBs never had these tables):
 *   1. PURGE the plaintext secrets: for every registered database, delete the
 *      `company_session_envs` rows its `env_keys_json` maps to. Envs NOT
 *      referenced by a database row are left untouched (user/agent config).
 *   2. DROP `company_session_databases`.
 *   3. `db_query_history.source` TEXT — lets agent-executed queries (db_query)
 *      land in the db-client history alongside UI-executed ones.
 *
 * `company_session_databases` stays in the project-DB trim drop-list for one
 * release so pre-191 project DBs still get cleaned. Old envs on DBs that
 * already ran the trim are unaffected (env purge is central-DB only, where
 * both tables live).
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

export const retireCompanySessionDatabases191: Migration = {
  version: 191,
  name: 'retire_company_session_databases',
  up: (db: DB): void => {
    if (tableExists(db, 'company_session_databases')) {
      // 1. Purge the plaintext connection-string envs each database row owned.
      if (tableExists(db, 'company_session_envs')) {
        const rows = db
          .prepare(`SELECT session_id, env_keys_json FROM company_session_databases`)
          .all() as Array<{ session_id: number; env_keys_json: string }>;
        const deleteEnv = db.prepare(
          `DELETE FROM company_session_envs WHERE session_id = ? AND key = ?`,
        );
        for (const row of rows) {
          let envKeys: Record<string, unknown>;
          try {
            envKeys = JSON.parse(row.env_keys_json) as Record<string, unknown>;
          } catch {
            continue; // corrupt map → nothing safe to purge for this row
          }
          for (const key of Object.values(envKeys)) {
            if (typeof key === 'string' && key) deleteEnv.run(row.session_id, key);
          }
        }
      }
      // 2. Drop the registry itself (indexes go with the table).
      db.exec(`DROP TABLE IF EXISTS company_session_databases`);
    }

    // 3. Agent-run queries surface in the db-client history (migration 174).
    addColumnIfMissing(db, 'db_query_history', 'source', 'TEXT');
  },
};
