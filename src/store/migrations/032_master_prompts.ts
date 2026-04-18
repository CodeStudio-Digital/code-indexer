/**
 * Migration 032 — Persist master↔human prompts (ask_user questions and
 * submit_plan approvals) in a dedicated table.
 *
 * Before this, pending master questions/plans lived only in frontend
 * React state — navigating away or refreshing the page dropped them, and
 * the SSE buffer could later replay stale `master_question_posted`
 * events, reopening already-answered questions. With this table the
 * prompt is the source of truth: the dashboard rehydrates from the DB,
 * SSE events carry the prompt `id` for idempotent upsert, and answers
 * are preserved for audit/display.
 */
import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export const masterPrompts032 = {
  version: 32,
  name: 'master_prompts',
  up(db: DB) {
    db.exec(`
      CREATE TABLE company_master_prompts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_session_id INTEGER NOT NULL,
        agent_run_id INTEGER,
        kind TEXT NOT NULL CHECK(kind IN ('question','plan')),
        runner_block_id TEXT,
        body TEXT NOT NULL,
        options_json TEXT,
        allow_freeform INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending','answered','cancelled')),
        answer TEXT,
        approved INTEGER,
        feedback TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT,
        FOREIGN KEY (company_session_id)
          REFERENCES company_sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX idx_master_prompts_session
        ON company_master_prompts(company_session_id, created_at);

      CREATE INDEX idx_master_prompts_pending
        ON company_master_prompts(company_session_id, status);
    `);
  },
};
