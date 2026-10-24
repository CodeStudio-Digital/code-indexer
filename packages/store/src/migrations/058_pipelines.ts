/**
 * Migration 058 — Pipelines.
 *
 * Adds three tables to support n8n-style executable pipelines on top of the
 * existing company orchestrator. The graph is stored as JSON; execution
 * state is normalised so the original runtime could query progress without
 * parsing JSON. Migration 265 retires these tables after preserving upgrade
 * compatibility for databases created before that removal.
 *
 *   - `pipelines`               — definition (graph + metadata). Reusable;
 *                                 `company_session_id` NULL means global.
 *   - `pipeline_executions`     — per-run state machine; `context_json`
 *                                 carries `{snapshot, vars}` so an edit to
 *                                 the source pipeline cannot mutate a
 *                                 running execution.
 *   - `pipeline_node_executions`— per-node attempt; tracks the
 *                                 `kanban_card_id` and `agent_run_id` so
 *                                 the dashboard can deep-link to the work.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const pipelines058: Migration = {
  version: 58,
  name: 'pipelines',
  up(db: DB) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pipelines (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        name               TEXT NOT NULL,
        description        TEXT NOT NULL DEFAULT '',
        company_session_id INTEGER REFERENCES company_sessions(id) ON DELETE CASCADE,
        template_id        INTEGER REFERENCES company_templates(id) ON DELETE SET NULL,
        graph_json         TEXT NOT NULL,
        version            INTEGER NOT NULL DEFAULT 1,
        created_at         TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_pipelines_session
        ON pipelines(company_session_id);
      CREATE INDEX IF NOT EXISTS idx_pipelines_template
        ON pipelines(template_id);
      CREATE INDEX IF NOT EXISTS idx_pipelines_name
        ON pipelines(name);

      CREATE TABLE IF NOT EXISTS pipeline_executions (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        pipeline_id        INTEGER NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
        company_session_id INTEGER NOT NULL REFERENCES company_sessions(id) ON DELETE CASCADE,
        status             TEXT NOT NULL DEFAULT 'running'
                             CHECK(status IN ('running','paused','completed','failed','aborted')),
        current_node_id    TEXT,
        initial_input      TEXT NOT NULL DEFAULT '',
        context_json       TEXT NOT NULL DEFAULT '{}',
        started_by         TEXT NOT NULL DEFAULT 'master',
        started_at         TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at        TEXT,
        error_message      TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_pipeline_exec_session
        ON pipeline_executions(company_session_id, status);
      CREATE INDEX IF NOT EXISTS idx_pipeline_exec_pipeline
        ON pipeline_executions(pipeline_id);
      CREATE INDEX IF NOT EXISTS idx_pipeline_exec_status
        ON pipeline_executions(status);

      CREATE TABLE IF NOT EXISTS pipeline_node_executions (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        execution_id    INTEGER NOT NULL REFERENCES pipeline_executions(id) ON DELETE CASCADE,
        node_id         TEXT NOT NULL,
        node_label      TEXT NOT NULL,
        role            TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending'
                          CHECK(status IN ('pending','running','completed','failed','skipped','aborted')),
        agent_run_id    INTEGER REFERENCES company_agent_runs(id) ON DELETE SET NULL,
        kanban_card_id  INTEGER REFERENCES kanban_cards(id) ON DELETE SET NULL,
        input_text      TEXT NOT NULL DEFAULT '',
        output_text     TEXT,
        outcome_branch  TEXT,
        attempt         INTEGER NOT NULL DEFAULT 1,
        started_at      TEXT,
        finished_at     TEXT,
        error_message   TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_pne_execution
        ON pipeline_node_executions(execution_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_pne_agent_run
        ON pipeline_node_executions(agent_run_id);
      CREATE INDEX IF NOT EXISTS idx_pne_card
        ON pipeline_node_executions(kanban_card_id);
    `);
  },
};
