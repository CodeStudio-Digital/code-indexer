/**
 * Migration 097 — DocsAgent research sessions.
 *
 * Persists each invocation of the DocsAgent (multi-step retrieval over
 * `doc_chunks`). Distinct from `coder_sessions` because the schema is
 * docs-specific (final markdown, cited chunk ids, confidence label) and
 * we don't want to pollute the coder schema with nullable doc columns.
 *
 * Triggered by:
 *   - `'user'` — operator opened the "Research" tab in the dashboard.
 *   - `'coder'` — a coder session called the `docs_deep_research` tool;
 *     `parent_coder_session_id` is set so the dashboard can render the
 *     research timeline inline with the calling chat session.
 *
 * Telemetry columns mirror the per-turn counters surfaced in the
 * dashboard timeline. `cost_usd` is the sum of provider-reported costs
 * over all LLM calls (rewriter + reranker + scorer_llm + classifier);
 * tokens are split into input/output for accounting.
 *
 * Status transitions (with no DB-level enforcement):
 *   running → completed   (success, docs_finish called)
 *   running → failed      (max_turns hit, exception, abort by user)
 *   running → aborted     (user manually cancelled via SSE close)
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const docsResearchSessions097: Migration = {
  version: 97,
  name: 'docs_research_sessions',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS docs_research_sessions (
        id                       INTEGER PRIMARY KEY AUTOINCREMENT,
        triggered_by             TEXT NOT NULL CHECK(triggered_by IN ('user','coder')),
        parent_coder_session_id  INTEGER REFERENCES coder_sessions(id) ON DELETE SET NULL,
        query                    TEXT NOT NULL,
        collections_json         TEXT,                  -- JSON array of collection names (optional filter)
        status                   TEXT NOT NULL DEFAULT 'running'
                                   CHECK(status IN ('running','completed','failed','aborted')),
        -- Telemetry counters
        num_turns                INTEGER NOT NULL DEFAULT 0,
        num_searches             INTEGER NOT NULL DEFAULT 0,
        num_chunks_read          INTEGER NOT NULL DEFAULT 0,
        query_rewrites_used      INTEGER NOT NULL DEFAULT 0,
        reranks_used             INTEGER NOT NULL DEFAULT 0,
        -- Final output
        final_markdown           TEXT,
        final_chunk_ids_json     TEXT,                  -- JSON array of chunk ids cited
        confidence               TEXT CHECK(confidence IN ('high','medium','low') OR confidence IS NULL),
        error_message            TEXT,
        -- Costs
        input_tokens             INTEGER NOT NULL DEFAULT 0,
        output_tokens            INTEGER NOT NULL DEFAULT 0,
        cost_usd                 REAL NOT NULL DEFAULT 0,
        -- Timestamps
        started_at               TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at             TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_docs_research_sessions_parent
        ON docs_research_sessions(parent_coder_session_id, started_at);

      CREATE INDEX IF NOT EXISTS idx_docs_research_sessions_status
        ON docs_research_sessions(status, started_at);
    `);
  },
};
