/**
 * Migration 098 — Cache for the doc-search reranker verdicts.
 *
 * Re-running the same (query, candidate-set) pair through the reranker
 * is expensive — every call is N pairwise LLM evaluations. We cache the
 * reranked order keyed by:
 *   - `query_hash`     — SHA-256 of the normalized query
 *   - `candidates_hash`— SHA-256 of the sorted candidate chunk-id list
 *   - `model_id`       — distinguishes Llama-8B verdicts from Cohere etc.
 *
 * The cached `reranked_order_json` is a JSON array of {chunk_id, score}
 * tuples that the reranker can hand directly to the caller, skipping the
 * LLM round-trip entirely on a hit.
 *
 * TTL: pruned at boot + periodically by deleting rows where
 * `created_at < datetime('now', '-1 days')`. We don't validate against
 * `doc_chunks.content_hash` on read in the MVP — a 24h TTL is enough
 * coverage for the dominant case (re-ranks driven by retries or repeated
 * agent queries within a single coder session).
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const docRerankCache098: Migration = {
  version: 98,
  name: 'doc_rerank_cache',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS doc_rerank_cache (
        query_hash            TEXT NOT NULL,
        candidates_hash       TEXT NOT NULL,
        model_id              TEXT NOT NULL,
        reranked_order_json   TEXT NOT NULL,
        created_at            TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (query_hash, candidates_hash, model_id)
      );

      CREATE INDEX IF NOT EXISTS idx_doc_rerank_cache_created
        ON doc_rerank_cache(created_at);
    `);
  },
};
