/**
 * Migration 233 — remove superseded vector-id mirrors and retry queues.
 *
 * `semantic_items` is the sole logical vector ledger. Physical vectors live
 * in the router-owned SQLite files, so retaining a second mapping in the
 * central/project index databases can only drift from the active generation.
 * The remote-delete queues are obsolete because vector storage is local-only.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function hasColumn(db: DB, table: string, column: string): boolean {
  const exists = db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`,
  ).get(table);
  if (!exists) return false;
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .some((entry) => entry.name === column);
}

export const removeLegacyVectorLedgers233: Migration = {
  version: 233,
  name: 'remove_legacy_vector_ledgers',
  up(db: DB): void {
    db.exec(`
      DROP TABLE IF EXISTS vector_ids;
      DROP TABLE IF EXISTS doc_chunk_vectors;
      DROP TABLE IF EXISTS pending_vector_deletes;
      DROP TABLE IF EXISTS doc_vector_tombstones;
      DROP TABLE IF EXISTS embedding_configs;
      DROP TABLE IF EXISTS vector_store_configs;
      DROP TABLE IF EXISTS reranker_configs;
      DROP TABLE IF EXISTS embedding_store_configs;
    `);
    // This flag belonged to failed remote Vectorize deletes. Durable semantic
    // jobs/deltas now own local cleanup state, so retaining the project-level
    // bit would expose a second, stale source of truth.
    if (hasColumn(db, 'projects', 'pending_vector_gc')) {
      db.exec(`ALTER TABLE projects DROP COLUMN pending_vector_gc`);
    }
  },
};
