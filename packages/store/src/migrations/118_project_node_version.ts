/**
 * Migration 118 — per-project Node.js version selector.
 *
 * Stores the chosen Node runtime id for a project (e.g. 'system',
 * 'nvm:20.11.0', 'managed:20.11.0'). NULL means "use the system default"
 * (whatever `node` is on PATH). Resolved to a bin dir at spawn time and
 * prepended to PATH so the project terminal AND the runner use it.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const projectNodeVersion118: Migration = {
  version: 118,
  name: 'project_node_version',
  up: (db: DB): void => {
    db.exec(`ALTER TABLE projects ADD COLUMN node_version TEXT;`);
  },
};
