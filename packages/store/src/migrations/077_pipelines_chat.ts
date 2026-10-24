/**
 * Migration 077 — Pipelines for chat sessions.
 *
 * Lets a `pipeline_execution` belong either to a `company_session` (the
 * existing orchestrator path) OR to a `coder_session` (the new chat
 * pipeline mode). SQLite cannot weaken `NOT NULL` via ALTER, so we
 * rebuild `pipeline_executions` with the relaxed schema + a CHECK that
 * exactly one of the two owner FKs is set.
 *
 *   - `pipeline_executions.company_session_id` — now nullable.
 *   - `pipeline_executions.coder_session_id`   — new, nullable; when
 *                                                 set, marks a chat
 *                                                 pipeline run owned by
 *                                                 that chat session.
 *   - `pipeline_node_executions.coder_session_id` — reserved for future
 *                                                   persisted child
 *                                                   sessions; NULL today.
 *   - `pipeline_node_executions.usage_json`    — per-stage token rollup
 *                                                 so the parent chat's
 *                                                 counter can include
 *                                                 the subagent's cost.
 *
 * Indexes that referenced the rebuilt table are recreated. The rebuild
 * is idempotent at the runner level (migrations only run once).
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const pipelinesChat077: Migration = {
  version: 77,
  name: 'pipelines_chat',
  up(db: DB) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pipeline_executions_new (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        pipeline_id        INTEGER NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
        company_session_id INTEGER REFERENCES company_sessions(id) ON DELETE CASCADE,
        coder_session_id   INTEGER REFERENCES coder_sessions(id) ON DELETE CASCADE,
        status             TEXT NOT NULL DEFAULT 'running'
                             CHECK(status IN ('running','paused','completed','failed','aborted')),
        current_node_id    TEXT,
        initial_input      TEXT NOT NULL DEFAULT '',
        context_json       TEXT NOT NULL DEFAULT '{}',
        started_by         TEXT NOT NULL DEFAULT 'master',
        started_at         TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at        TEXT,
        error_message      TEXT,
        CHECK (
          (company_session_id IS NOT NULL AND coder_session_id IS NULL) OR
          (company_session_id IS NULL     AND coder_session_id IS NOT NULL)
        )
      );

      INSERT OR IGNORE INTO pipeline_executions_new
        (id, pipeline_id, company_session_id, coder_session_id, status, current_node_id,
         initial_input, context_json, started_by, started_at, finished_at, error_message)
      SELECT id, pipeline_id, company_session_id, NULL, status, current_node_id,
             initial_input, context_json, started_by, started_at, finished_at, error_message
      FROM pipeline_executions;

      DROP TABLE pipeline_executions;
      ALTER TABLE pipeline_executions_new RENAME TO pipeline_executions;

      CREATE INDEX IF NOT EXISTS idx_pipeline_exec_session
        ON pipeline_executions(company_session_id, status);
      CREATE INDEX IF NOT EXISTS idx_pipeline_exec_coder
        ON pipeline_executions(coder_session_id, status);
      CREATE INDEX IF NOT EXISTS idx_pipeline_exec_pipeline
        ON pipeline_executions(pipeline_id);
      CREATE INDEX IF NOT EXISTS idx_pipeline_exec_status
        ON pipeline_executions(status);

      ALTER TABLE pipeline_node_executions ADD COLUMN coder_session_id INTEGER
        REFERENCES coder_sessions(id) ON DELETE SET NULL;
      ALTER TABLE pipeline_node_executions ADD COLUMN usage_json TEXT;
    `);
  },
};
