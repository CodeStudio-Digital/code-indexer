/**
 * Migration 169 — `project_runtime_config.package_managers`.
 *
 * Per-project package-manager preference for the dependency assistant in the
 * project settings: JSON `{"node":"pnpm","python":"poetry"}`. PHP is fixed
 * (composer) so it has no key. NULL/missing key = "auto" (the runner detects
 * the manager from the lockfile/manifest, as today). Lives in the routed
 * `project_runtime_config` table (migration 168) so it travels with the folder.
 *
 * Read/write is transparent: CodeIndexDB.getProject overlays it and
 * updateProject routes writes here, alongside the other runtime fields.
 *
 * Forward-idempotent + zero-impact: column added only if missing. Runs on the
 * central DB and (via the shared schema lineage) on every per-project DB.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const projectPackageManagers169: Migration = {
  version: 169,
  name: 'project_package_managers',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'project_runtime_config', 'package_managers', 'TEXT');
  },
};
