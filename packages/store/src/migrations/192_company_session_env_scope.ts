/**
 * Migration 192 — per-service scope on shared session env vars (D1).
 *
 * `company_session_envs.service_scope` restricts WHERE a variable is
 * materialized:
 *   - NULL (default)  → the var goes to EVERY service container of the
 *     session (pre-192 behavior, preserved for all existing rows).
 *   - 'api'           → only the `api` service sees the var.
 *   - 'main,api'      → CSV of service ids; the primary container is
 *     addressed as `main` (same id the services listing + managed-env
 *     key synthesis use).
 *
 * Service ids are NOT foreign-keyed: services are created/destroyed
 * far more often than envs are edited, and a dangling id is harmless
 * (the var simply reaches no container until the service re-appears).
 * Parsing/matching lives in `env-scope.ts`; enforcement happens at
 * `.env` materialization (env-sync + provision paths).
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

export const companySessionEnvScope192: Migration = {
  version: 192,
  name: 'company_session_env_scope',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'company_session_envs', 'service_scope', 'TEXT');
  },
};
