/**
 * Migration 004 — Coder agent sessions.
 *
 * Adds three tables that persist the coder agent's chat history:
 *   - coder_sessions: one row per conversation, scoped to a project
 *   - coder_messages: ordered messages within a session (content stored as JSON)
 *   - coder_tool_calls: per-tool-call telemetry (args, result, duration, status)
 *
 * Sessions are deleted when their project is deleted (ON DELETE CASCADE).
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const coderSessions004: Migration = {
  version: 4,
  name: 'coder_sessions',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS coder_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'idle',
        total_input_tokens INTEGER NOT NULL DEFAULT 0,
        total_output_tokens INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_coder_sessions_project_updated
        ON coder_sessions(project_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS coder_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES coder_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content_json TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_coder_messages_session
        ON coder_messages(session_id, id);

      CREATE TABLE IF NOT EXISTS coder_tool_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL REFERENCES coder_messages(id) ON DELETE CASCADE,
        tool_use_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        args_json TEXT NOT NULL,
        result_text TEXT,
        is_error INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_coder_tool_calls_message
        ON coder_tool_calls(message_id);
    `);
  },
};
