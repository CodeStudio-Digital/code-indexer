/**
 * Migration 008 — Structured task list state for coder sessions.
 *
 * Companion to the new submit_tasks/execute_task/task_complete tools that
 * let the orchestrator decompose work into a curated task list and
 * optionally delegate each task to an isolated subagent for token economy.
 *
 * The whole task list lives as a single JSON blob keyed by session_id —
 * we keep the schema flexible while iterating. Once the shape stabilizes
 * we may normalize to one row per task. Versioning is monotonic so the
 * dashboard can detect stale updates over SSE.
 *
 * Purely additive: only adds the new table, never touches existing ones.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const coderTasks008: Migration = {
  version: 8,
  name: 'coder_tasks',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS coder_tasks_state (
        session_id     INTEGER PRIMARY KEY REFERENCES coder_sessions(id) ON DELETE CASCADE,
        tool_use_id    TEXT NOT NULL,
        state          TEXT NOT NULL,
        version        INTEGER NOT NULL DEFAULT 1,
        created_at     TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_coder_tasks_state_updated
        ON coder_tasks_state(updated_at DESC);
    `);
  },
};
