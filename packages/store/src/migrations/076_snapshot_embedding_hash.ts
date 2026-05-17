/**
 * Migration 076 — `embedding_hash` column on `snapshots`.
 *
 * Mirrors migration 012 (files/symbols): lets the snapshot service skip
 * re-embedding unchanged title+content across runs and gives backfill a
 * cheap "missing embedding" predicate (`embedding_hash IS NULL`).
 *
 * Existing rows get NULL and are picked up on the next backfill or the next
 * embed-on-write cycle. Vector ids continue to live in the existing
 * `vector_ids` table (which already supports `type='snapshot'`).
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const snapshotEmbeddingHash076: Migration = {
  version: 76,
  name: 'snapshot_embedding_hash',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'snapshots', 'embedding_hash', 'TEXT');
  },
};
