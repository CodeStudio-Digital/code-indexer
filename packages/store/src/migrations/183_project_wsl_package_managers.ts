/**
 * Migration 183 — `project_runtime_config.wsl_package_managers`.
 *
 * Per-project, per-WSL-distro package-manager preference (Node/Python): JSON
 * `{"Ubuntu":{"node":"npm","python":"pip"}}`. Lets a project use one manager on
 * the Windows host (`package_managers`) and a different one inside a WSL distro —
 * e.g. `yarn` on Windows, `npm` in WSL where the managed Node always ships it.
 * Missing/NULL key = auto (runner detects from the lockfile/manifest).
 *
 * Lives in the routed `project_runtime_config` table (migration 168) so it
 * travels with the project folder. NO central `projects` column — MUST be
 * destructured out in updateProject (like package_managers / wsl_runtime_versions).
 *
 * Forward-idempotent + zero-impact: column added only if missing.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const projectWslPackageManagers183: Migration = {
  version: 183,
  name: 'project_wsl_package_managers',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'project_runtime_config', 'wsl_package_managers', 'TEXT');
  },
};
