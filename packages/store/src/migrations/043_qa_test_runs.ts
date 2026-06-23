/**
 * Migration 043 — QA test runs and per-test results.
 *
 * Persists the output of every `npx playwright test ...` invocation a QA
 * subordinate makes, so the dashboard's TestsTab can render history,
 * drill-down details, and a live tree of running tests.
 *
 * Two tables:
 *   - `qa_test_runs`     — one row per suite invocation; status lifecycle
 *                          `running → completed | aborted | error`.
 *   - `qa_test_results`  — one row per `test(...)` outcome inside a run.
 *
 * Both are scoped to a company session via `qa_test_runs.company_session_id`.
 * Cascading delete makes session cleanup atomic.
 *
 * Indexes prioritise the two hot reads from the UI:
 *   - "give me the last N runs of session X" → idx_qa_runs_session.
 *   - "give me all results of run R"          → idx_qa_results_run.
 *   - "is this spec.test currently flaky?"    → idx_qa_results_spec.
 *
 * `trace_path` stores a workspace-relative path (the trace lives inside
 * the sandbox container's filesystem). The dedicated `/api/.../trace`
 * route (phase 2B) validates and serves it.
 */
import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export const qaTestRuns043 = {
  version: 43,
  name: 'qa_test_runs',
  up(db: DB) {
    db.exec(`
      CREATE TABLE qa_test_runs (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        company_session_id  INTEGER NOT NULL
                            REFERENCES company_sessions(id) ON DELETE CASCADE,
        agent_run_id        INTEGER
                            REFERENCES company_agent_runs(id) ON DELETE SET NULL,
        suite               TEXT NOT NULL,
        status              TEXT NOT NULL
                            CHECK(status IN ('running','completed','aborted','error')),
        started_at          TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at        TEXT,
        passed              INTEGER NOT NULL DEFAULT 0,
        failed              INTEGER NOT NULL DEFAULT 0,
        skipped             INTEGER NOT NULL DEFAULT 0,
        duration_ms         INTEGER,
        trigger             TEXT NOT NULL DEFAULT 'agent'
                            CHECK(trigger IN ('agent','human','watcher'))
      );

      CREATE INDEX idx_qa_runs_session
        ON qa_test_runs(company_session_id, started_at DESC);

      CREATE INDEX idx_qa_runs_status
        ON qa_test_runs(status, started_at DESC);

      CREATE TABLE qa_test_results (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id      INTEGER NOT NULL
                    REFERENCES qa_test_runs(id) ON DELETE CASCADE,
        spec_file   TEXT NOT NULL,
        test_name   TEXT NOT NULL,
        status      TEXT NOT NULL
                    CHECK(status IN ('passed','failed','skipped','timed-out','interrupted')),
        duration_ms INTEGER,
        error       TEXT,
        trace_path  TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX idx_qa_results_run
        ON qa_test_results(run_id);

      CREATE INDEX idx_qa_results_spec
        ON qa_test_results(spec_file, test_name, created_at DESC);
    `);
  },
};
