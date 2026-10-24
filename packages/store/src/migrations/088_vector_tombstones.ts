/**
 * Migration 088 — Vector tombstones for orphan cleanup on DELETE.
 *
 * When the user deletes a doc source or collection, the SQLite-side state
 * is cleaned via the existing `ON DELETE CASCADE` chain (migration 086).
 * But the corresponding embeddings in the EXTERNAL vector store
 * (Cloudflare Vectorize / Qdrant / Pinecone / OpenSearch) stayed orphaned
 * — costing money and polluting search candidates (silently filtered, but
 * wasted bandwidth).
 *
 * The new `IndexDocumentationUseCase.deleteSource/deleteCollection` paths
 * try to call `vectorStore.deleteByIds(ids)` synchronously. When that
 * call fails (network, store down, 5xx), we still complete the SQLite
 * delete and enqueue the leftover ids here. A boot-time sweep drains the
 * queue best-effort on the next server start.
 *
 * `UNIQUE(vector_id, provider)` keeps the queue deduped — repeated
 * failures don't pile up duplicate rows for the same vector.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const vectorTombstones088: Migration = {
  version: 88,
  name: 'vector_tombstones',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS doc_vector_tombstones (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        vector_id      TEXT NOT NULL,
        provider       TEXT NOT NULL,
        deleted_at     TEXT NOT NULL DEFAULT (datetime('now')),
        last_retry_at  TEXT,
        retry_count    INTEGER NOT NULL DEFAULT 0,
        last_error     TEXT,
        UNIQUE(vector_id, provider)
      );

      CREATE INDEX IF NOT EXISTS idx_doc_vector_tombstones_pending
        ON doc_vector_tombstones(provider, deleted_at);
    `);
  },
};
