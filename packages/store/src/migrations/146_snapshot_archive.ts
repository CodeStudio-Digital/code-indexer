/**
 * Migration 146 — soft-delete / archive for project memory snapshots.
 *
 * The periodic memory consolidator (Workstream B) merges near-duplicate
 * snapshots and garbage-collects fully-stale, low-importance, cold ones.
 * Removal MUST be reversible — durable memory is never hard-deleted silently —
 * so this adds a nullable `archived_at` flag (NULL = live) plus a free-text
 * `archived_reason` ("merged:<winnerId>" | "stale+cold+low-importance").
 *
 * Every read path that feeds the agent excludes archived rows via
 * `archived_at IS NULL`; the covering index keeps that filter cheap.
 * Existing rows default to NULL → all currently-live, zero behaviour change.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const snapshotArchive146: Migration = {
  version: 146,
  name: 'snapshot_archive',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'snapshots', 'archived_at', 'TEXT');
    addColumnIfMissing(db, 'snapshots', 'archived_reason', 'TEXT');
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_snapshots_project_live
        ON snapshots(project_id, archived_at);
    `);
  },
};
