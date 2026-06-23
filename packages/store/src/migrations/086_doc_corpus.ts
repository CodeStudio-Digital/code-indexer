/**
 * Migration 086 — Documentation corpus (global RAG over external docs).
 *
 * Introduces four GLOBAL tables (no `project_id`) that back the
 * "Documentação" sidebar feature: a corpus of user-curated docs
 * (PDFs and crawled URLs) that any project's agent can query via the
 * `rag_search_docs` native tool.
 *
 *   1. `doc_collections`     — named buckets (e.g. "unity-docs", "react-docs").
 *   2. `doc_sources`         — one row per ingested PDF/URL; the URL row's
 *                              `crawl_*` columns describe the BFS frontier.
 *   3. `doc_chunks`          — atomic unit of retrieval (heading-aware splits).
 *   4. `doc_chunk_vectors`   — chunk → external vector_id mapping (parallel to
 *                              the existing `vector_ids` table but cascaded on
 *                              chunk deletion since docs lifecycle is per-chunk).
 *
 * LLM model selection (relevance gate / enricher / reranker / embedder) is
 * NOT stored on `doc_collections` — it lives in `pipeline_provider_bindings`
 * (migration 085) under `pipeline_name IN ('doc_ingest','doc_search')`, so
 * the admin's existing PipelineBindings UI Just Works™.
 *
 * The companion `doc_chunks_fts` virtual table + sync triggers live in
 * `db.ts` (same convention as `snapshots_fts` — FTS5 setup is programmatic
 * to keep migrations free of FTS-engine syntax).
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const docCorpus086: Migration = {
  version: 86,
  name: 'doc_corpus',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS doc_collections (
        id                       INTEGER PRIMARY KEY AUTOINCREMENT,
        name                     TEXT NOT NULL UNIQUE,
        description              TEXT,
        status                   TEXT NOT NULL DEFAULT 'idle'
                                   CHECK(status IN ('idle','indexing','error')),
        status_message           TEXT,
        embedding_provider_id    TEXT,
        chunk_count              INTEGER NOT NULL DEFAULT 0,
        source_count             INTEGER NOT NULL DEFAULT 0,
        created_at               TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_doc_collections_status
        ON doc_collections(status);
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS doc_sources (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        collection_id       INTEGER NOT NULL REFERENCES doc_collections(id) ON DELETE CASCADE,
        type                TEXT NOT NULL CHECK(type IN ('pdf','url')),
        uri                 TEXT NOT NULL,
        title               TEXT,
        status              TEXT NOT NULL DEFAULT 'queued'
                              CHECK(status IN ('queued','fetching','indexing','done','error')),
        error_message       TEXT,
        content_hash        TEXT,
        chunk_count         INTEGER NOT NULL DEFAULT 0,
        page_count          INTEGER NOT NULL DEFAULT 0,
        pages_accepted      INTEGER NOT NULL DEFAULT 0,
        pages_rejected      INTEGER NOT NULL DEFAULT 0,
        last_indexed_at     TEXT,
        -- Crawl config (URL only). Discrete columns so future queries can
        -- filter on, e.g. "all sources with max_pages > 100".
        crawl_enabled       INTEGER NOT NULL DEFAULT 0,
        crawl_max_pages     INTEGER NOT NULL DEFAULT 1,
        crawl_max_depth     INTEGER NOT NULL DEFAULT 0,
        crawl_same_origin   INTEGER NOT NULL DEFAULT 1,
        crawl_include_pattern TEXT,
        crawl_exclude_pattern TEXT,
        pdf_size_bytes      INTEGER,
        cost_usd            REAL NOT NULL DEFAULT 0,
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(collection_id, uri)
      );

      CREATE INDEX IF NOT EXISTS idx_doc_sources_collection
        ON doc_sources(collection_id, status);
      CREATE INDEX IF NOT EXISTS idx_doc_sources_status
        ON doc_sources(status, updated_at);
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS doc_chunks (
        id                      INTEGER PRIMARY KEY AUTOINCREMENT,
        collection_id           INTEGER NOT NULL REFERENCES doc_collections(id) ON DELETE CASCADE,
        source_id               INTEGER NOT NULL REFERENCES doc_sources(id) ON DELETE CASCADE,
        ord                     INTEGER NOT NULL,
        heading_path            TEXT,             -- "Guide > Components > Button"
        content                 TEXT NOT NULL,
        content_hash            TEXT NOT NULL,
        summary                 TEXT,             -- LLM enrichment
        concepts                TEXT,             -- JSON array of tags (LLM enrichment)
        token_count             INTEGER NOT NULL DEFAULT 0,
        embedding_hash          TEXT,             -- NULL = needs embedding
        embedding_provider_id   TEXT,             -- which provider last embedded
        source_uri              TEXT,             -- denormalized for fast result rendering
        created_at              TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(source_id, ord)
      );

      CREATE INDEX IF NOT EXISTS idx_doc_chunks_collection
        ON doc_chunks(collection_id);
      CREATE INDEX IF NOT EXISTS idx_doc_chunks_source_ord
        ON doc_chunks(source_id, ord);
      CREATE INDEX IF NOT EXISTS idx_doc_chunks_pending_embed
        ON doc_chunks(collection_id, embedding_hash) WHERE embedding_hash IS NULL;
      CREATE INDEX IF NOT EXISTS idx_doc_chunks_content_hash
        ON doc_chunks(content_hash);
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS doc_chunk_vectors (
        chunk_id    INTEGER NOT NULL REFERENCES doc_chunks(id) ON DELETE CASCADE,
        vector_id   TEXT NOT NULL,
        provider    TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (chunk_id, provider)
      );

      CREATE INDEX IF NOT EXISTS idx_doc_chunk_vectors_vector
        ON doc_chunk_vectors(vector_id);
    `);
  },
};
