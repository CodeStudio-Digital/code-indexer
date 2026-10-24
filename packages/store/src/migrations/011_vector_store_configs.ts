/**
 * Migration 011 — Vector store configs.
 *
 * Adds a pluggable vector-backend table mirroring `embedding_configs` from
 * migration 006. Lets the admin UI pick between Cloudflare Vectorize, Qdrant,
 * Pinecone, or Bedrock+OpenSearch as the storage for embedding vectors —
 * independently of which embedding model generates them.
 *
 * Additive only. Legacy .env-configured Cloudflare still works via the
 * `createVectorStore()` fallback in src/store/vectors.ts.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const vectorStoreConfigs011: Migration = {
  version: 11,
  name: 'vector_store_configs',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS vector_store_configs (
        id         TEXT PRIMARY KEY,
        kind       TEXT NOT NULL,
        name       TEXT NOT NULL,
        enabled    INTEGER NOT NULL DEFAULT 0,
        is_default INTEGER NOT NULL DEFAULT 0,
        config     TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  },
};
