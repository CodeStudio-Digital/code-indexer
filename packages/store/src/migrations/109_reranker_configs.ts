/**
 * Migration 109 — Reranker configs.
 *
 * Adds a pluggable cross-encoder reranker table mirroring `embedding_configs`
 * (migration 006) and `vector_store_configs` (migration 011). Lets the admin
 * UI turn reranking on/off and pick between Cloudflare Workers AI
 * (@cf/baai/bge-reranker-base) and Cohere Rerank — independently of the
 * embedding model and vector backend.
 *
 * Additive only. When no row is marked default+enabled, `createReranker()`
 * falls back to env (COHERE_API_KEY / MCP_RERANK_WORKER_URL) and finally to
 * the NullReranker (RRF-only ordering, the prior behavior).
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const rerankerConfigs109: Migration = {
  version: 109,
  name: 'reranker_configs',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS reranker_configs (
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
