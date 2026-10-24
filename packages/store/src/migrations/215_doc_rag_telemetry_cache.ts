/** Migration 215 — durable enrichment cache + privacy-preserving RAG telemetry. */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const docRagTelemetryCache215: Migration = {
  version: 215,
  name: 'doc_rag_telemetry_cache',
  up: (db: DB): void => {
    const hasDocs = !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='doc_chunks'`).get();
    if (!hasDocs) return;
    db.exec(`
      CREATE TABLE IF NOT EXISTS doc_enrichment_cache (
        content_hash TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        summary TEXT,
        concepts_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(content_hash, fingerprint)
      );
      CREATE TABLE IF NOT EXISTS doc_search_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER,
        query_hash TEXT NOT NULL,
        scope TEXT NOT NULL,
        collection_ids_json TEXT,
        mode TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        fts_hits INTEGER NOT NULL DEFAULT 0,
        vector_hits INTEGER NOT NULL DEFAULT 0,
        stale_vector_hits INTEGER NOT NULL DEFAULT 0,
        vector_coverage REAL,
        top_relevance REAL,
        no_good_match INTEGER NOT NULL DEFAULT 0,
        result_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_doc_search_events_created ON doc_search_events(created_at);
      CREATE INDEX IF NOT EXISTS idx_doc_search_events_project ON doc_search_events(project_id, created_at);
    `);
  },
};
