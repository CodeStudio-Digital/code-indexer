/**
 * Migration 176 — `projects.is_loose`.
 *
 * A GLOBAL session can be started from an ARBITRARY folder on disk (not a
 * project the user registered in the IDE). That folder still needs a `projects`
 * row so the virtual-workspace junction + indexer can key off a `project_id`,
 * but it is an "ad-hoc"/loose attachment: this flag marks such rows so
 * `db.listProjects()` hides them from the "Projetos" grid (they only ever
 * surface inside the global-session picker). Mirrors `is_synthetic` (mig 155).
 *
 * Forward-idempotent and zero-impact: every existing project gets `0`, so the
 * project list is unchanged.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const projectLoose176: Migration = {
  version: 176,
  name: 'project_loose',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'projects', 'is_loose', 'INTEGER NOT NULL DEFAULT 0');
  },
};
