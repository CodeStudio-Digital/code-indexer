/**
 * Migration 170 — `projects.git_remote` + `projects.default_branch`.
 *
 * A project optionally remembers its git remote URL + default branch. This is
 * project IDENTITY (not routed runtime config), so it lives on the base `projects`
 * table. It powers the "cloud project library": a project pointer ({name, gitRemote,
 * workspaceId}) syncs to the cloud (Pro = personal, Teams = shared org), and
 * "Import from cloud" clones the repo via git and restores the API workspace.
 * Auto-detected from `git remote get-url origin` on open/scaffold; NULL = none.
 *
 * Forward-idempotent + zero-impact: columns added only if missing.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const projectGitRemote170: Migration = {
  version: 170,
  name: 'project_git_remote',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'projects', 'git_remote', 'TEXT');
    addColumnIfMissing(db, 'projects', 'default_branch', 'TEXT');
  },
};
