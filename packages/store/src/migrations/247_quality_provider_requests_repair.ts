/**
 * Migration 247 — repair `provider_requests` on databases that recorded
 * migration 234 before that column was added to its source.
 *
 * Released migrations are immutable: once schema_version contains 234, the
 * runner will not execute it again. Keep this repair additive and guarded so
 * both drifted and fresh databases converge on the same schema.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function tableExists(db: DB, table: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
}

function columnExists(db: DB, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .some((row) => row.name === column);
}

export const qualityProviderRequestsRepair247: Migration = {
  version: 247,
  name: 'quality_provider_requests_repair',
  up(db: DB): void {
    if (!tableExists(db, 'quality_classifications')) return;
    if (columnExists(db, 'quality_classifications', 'provider_requests')) return;
    db.exec(`
      ALTER TABLE quality_classifications
      ADD COLUMN provider_requests INTEGER NOT NULL DEFAULT 0
    `);
  },
};
