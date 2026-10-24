import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

/** A stat-first reopen check is operational health, not a new index run. Keep
 * its timestamp separate from project metadata and from the last rebuild. */
export const structuralLastChecked231: Migration = {
  version: 231,
  name: 'structural_last_checked',
  up(db: DB): void {
    const projects = db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name='projects'`,
    ).get();
    if (!projects) return;
    const columns = db.prepare(`PRAGMA table_info(projects)`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'structural_last_checked_at')) {
      db.exec(`ALTER TABLE projects ADD COLUMN structural_last_checked_at TEXT`);
    }
  },
};
