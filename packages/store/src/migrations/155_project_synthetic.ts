/**
 * Migration 155 — `projects.is_synthetic`.
 *
 * A GLOBAL (multi-project) session runs as a normal session over a SYNTHETIC
 * union project whose `root_path` is a directory of junctions/symlinks to the
 * real linked projects (see `core/virtual-workspace.ts`). This flag marks such
 * rows so `db.listProjects()` hides them from the "Projetos" list and the
 * global-session project multi-select — they're an implementation detail, never
 * user-facing.
 *
 * Forward-idempotent and zero-impact: every existing project gets `0`, so the
 * project list is unchanged. Mirrors migration 150/151 (idempotent column add).
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const projectSynthetic155: Migration = {
  version: 155,
  name: 'project_synthetic',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'projects', 'is_synthetic', 'INTEGER NOT NULL DEFAULT 0');
  },
};
