/**
 * Migration 003 — Snapshot file references.
 *
 * Adds a `snapshot_files` table that records which files a snapshot
 * references plus the file's hash at the moment the snapshot was created.
 * Queries can then compare stored hash vs current hash and return a
 * `stale: true` flag for snapshots whose referenced files have changed.
 *
 * Snapshots that existed before this migration have no references and
 * are never marked stale (they pass through unchanged).
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const snapshotFiles003: Migration = {
  version: 3,
  name: 'snapshot_files',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS snapshot_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        file_hash_at_creation TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(snapshot_id, file_path)
      );

      CREATE INDEX IF NOT EXISTS idx_snapshot_files_snapshot
        ON snapshot_files(snapshot_id);
    `);
  },
};
