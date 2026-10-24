/**
 * Migration 083 — quality classifications.
 *
 * Stores the verdict of each Grox-style classifier (off_topic, completeness,
 * code_quality, policy, tool_misuse, …) applied to an agent output. Inspired
 * by `grox/classifiers/content/classifier.py` — single-task classifiers
 * emit verdict + reason + confidence, and the application layer decides
 * whether to block / warn / log.
 *
 * Multiple rows per output: one classifier per row. Indexed by
 * (agent_run_id, classifier_name) and (created_at) so the admin panel can
 * paginate by recency and filter by classifier.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const qualityClassifications083: Migration = {
  version: 83,
  name: 'quality_classifications',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS quality_classifications (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id      INTEGER,
        company_session_id INTEGER,
        agent_run_id    INTEGER,
        message_id      TEXT,
        classifier_name TEXT NOT NULL,
        verdict         TEXT NOT NULL,           -- 'ok' | 'warn' | 'flagged' | 'error'
        confidence      REAL,                    -- 0..1 (NULL if classifier doesn't emit one)
        reason          TEXT,
        provider_id     TEXT,                    -- which provider answered
        model_id        TEXT,                    -- which model answered
        latency_ms      REAL,
        cost_usd        REAL,
        raw_response_json TEXT,                  -- compressed if large
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_quality_run
        ON quality_classifications(agent_run_id, classifier_name, created_at);

      CREATE INDEX IF NOT EXISTS idx_quality_session
        ON quality_classifications(session_id, created_at);

      CREATE INDEX IF NOT EXISTS idx_quality_company
        ON quality_classifications(company_session_id, created_at);

      CREATE INDEX IF NOT EXISTS idx_quality_verdict
        ON quality_classifications(classifier_name, verdict, created_at);
    `);
  },
};
