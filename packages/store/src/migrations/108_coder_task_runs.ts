/**
 * Migration 108 — Persisted `execute_tasks` run audit trail.
 *
 * PR-B (execute_tasks robustness). Today, `executions` lives in RAM
 * (`Map<string, TaskRunContext>`); a worker restart loses the whole
 * run history. After this migration:
 *
 *   - `coder_task_runs`         one row per `execute_tasks` invocation.
 *   - `coder_task_run_items`    one row per task ATTEMPT (PR-C will
 *                               write multiple rows per task when
 *                               retry kicks in).
 *
 * Schema is forward-compatible with PR-C (`attempt` column) and PR-D
 * (`inputs_fingerprint` column ready for the skip-stale check).
 *
 * Purely additive: only adds the two tables, never touches existing
 * rows. Safe to backfill nothing — old sessions simply have no run
 * history visible in the dashboard's new "Runs" tab.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const coderTaskRuns108: Migration = {
  version: 108,
  name: 'coder_task_runs',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS coder_task_runs (
        run_id           TEXT PRIMARY KEY,
        session_id       INTEGER NOT NULL REFERENCES coder_sessions(id) ON DELETE CASCADE,
        mode             TEXT NOT NULL,             -- 'auto' | 'inline-all'
        started_at       TEXT NOT NULL,
        finished_at      TEXT,
        status           TEXT NOT NULL,             -- 'running'|'completed'|'failed'|'aborted'
        total_input_tokens   INTEGER NOT NULL DEFAULT 0,
        total_output_tokens  INTEGER NOT NULL DEFAULT 0,
        total_cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
        total_cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        budget_tokens    INTEGER,                   -- PR-E (token cap)
        budget_usd_cents INTEGER,                   -- PR-E ($ cap)
        reject_reason    TEXT,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_coder_task_runs_session
        ON coder_task_runs(session_id, started_at DESC);

      CREATE INDEX IF NOT EXISTS idx_coder_task_runs_status
        ON coder_task_runs(status, started_at DESC);

      CREATE TABLE IF NOT EXISTS coder_task_run_items (
        run_id            TEXT NOT NULL REFERENCES coder_task_runs(run_id) ON DELETE CASCADE,
        task_id           TEXT NOT NULL,
        attempt           INTEGER NOT NULL DEFAULT 0, -- PR-C will bump per retry
        wave_idx          INTEGER NOT NULL,
        parallel_group    TEXT,
        kind              TEXT NOT NULL,             -- 'investigate'|'implement'|'verify'
        title             TEXT NOT NULL,
        started_at        TEXT,
        finished_at       TEXT,
        status            TEXT NOT NULL,             -- pending|running|done|failed|skipped|interrupted
        tool_call_count   INTEGER NOT NULL DEFAULT 0,
        input_tokens      INTEGER NOT NULL DEFAULT 0,
        output_tokens     INTEGER NOT NULL DEFAULT 0,
        inputs_fingerprint TEXT,                     -- PR-D (skip-stale)
        skip_reason       TEXT,
        error             TEXT,
        summary           TEXT,
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (run_id, task_id, attempt)
      );

      CREATE INDEX IF NOT EXISTS idx_coder_task_run_items_run
        ON coder_task_run_items(run_id, wave_idx);

      CREATE INDEX IF NOT EXISTS idx_coder_task_run_items_task
        ON coder_task_run_items(task_id, finished_at DESC);

      CREATE INDEX IF NOT EXISTS idx_coder_task_run_items_status
        ON coder_task_run_items(status, started_at DESC);
    `);
  },
};
