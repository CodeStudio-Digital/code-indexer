/**
 * Migration 007 — Persisted plans table for coder sessions.
 *
 * Each call to the `submit_plan` tool persists a row here so the dashboard
 * can list/inspect plans long after the live `tool_use` block scrolled out
 * of view. Status is updated when the user approves/rejects (live or via
 * the resume path after a server restart).
 *
 * Schema is purely additive — never touches existing tables.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const coderPlans007: Migration = {
  version: 7,
  name: 'coder_plans',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS coder_plans (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id      INTEGER NOT NULL REFERENCES coder_sessions(id) ON DELETE CASCADE,
        tool_use_id     TEXT NOT NULL,
        message_id      INTEGER REFERENCES coder_messages(id) ON DELETE SET NULL,
        plan_text       TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending',
        feedback        TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at     TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_coder_plans_session
        ON coder_plans(session_id, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_coder_plans_tool_use
        ON coder_plans(tool_use_id);
    `);
  },
};
