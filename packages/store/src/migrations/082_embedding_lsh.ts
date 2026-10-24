/**
 * Migration 082 — LSH bucketing tables for the indexer.
 *
 *   embedding_simhash_signatures: 1 row per (project_id, entity_type, entity_id)
 *     stores the 32-bit SimHash signature.
 *
 *   embedding_lsh_buckets: N rows per entity (one per hash function), each
 *     row a (hash_idx, bucket_hash) tuple. The lookup query is
 *       SELECT entity_id FROM embedding_lsh_buckets
 *        WHERE project_id = ?
 *          AND (
 *               (hash_idx = 0 AND bucket_hash = ?)
 *            OR (hash_idx = 1 AND bucket_hash = ?)
 *               )
 *     followed by an in-memory dedup. Two candidates collide if they share
 *     ANY bucket — high recall, low latency.
 *
 * Both tables include `project_id` so multiple projects can share a DB
 * without cross-project collision.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const embeddingLsh082: Migration = {
  version: 82,
  name: 'embedding_lsh',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS embedding_simhash_signatures (
        project_id   INTEGER NOT NULL,
        entity_type  TEXT NOT NULL,         -- 'file' | 'symbol'
        entity_id    INTEGER NOT NULL,
        signature    INTEGER NOT NULL,      -- 32-bit unsigned
        dim          INTEGER NOT NULL,      -- source embedding dim, for sanity
        params_hash  TEXT NOT NULL,         -- digest of (numHyperplanes, seed)
        updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (project_id, entity_type, entity_id)
      );

      CREATE INDEX IF NOT EXISTS idx_simhash_project
        ON embedding_simhash_signatures(project_id, entity_type);

      CREATE TABLE IF NOT EXISTS embedding_lsh_buckets (
        project_id   INTEGER NOT NULL,
        entity_type  TEXT NOT NULL,
        entity_id    INTEGER NOT NULL,
        hash_idx     INTEGER NOT NULL,      -- 0..M-1
        bucket_hash  INTEGER NOT NULL,
        PRIMARY KEY (project_id, entity_type, entity_id, hash_idx)
      );

      CREATE INDEX IF NOT EXISTS idx_lsh_bucket_lookup
        ON embedding_lsh_buckets(project_id, entity_type, hash_idx, bucket_hash);
    `);
  },
};
