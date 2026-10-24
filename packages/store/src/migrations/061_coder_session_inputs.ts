/**
 * Migration 061 — Hidden-input log per coder session.
 *
 * Records every prompt-like text the agent receives that isn't a normal
 * user/assistant/tool message: the full system prompt at run-start, skill
 * bodies fetched mid-conversation via `get_skill_content`, runtime
 * system-reminders, and system prompts handed to spawned sub-agents.
 *
 * Powers the "Input" tab in the session details modal so users can see what
 * the model actually got under the hood.
 *
 * Dedup is enforced application-side by hashing `content` and only inserting
 * when the latest row for the same `(session_id, kind)` differs.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const coderSessionInputs061: Migration = {
  version: 61,
  name: 'coder_session_inputs',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS coder_session_inputs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id    INTEGER NOT NULL REFERENCES coder_sessions(id) ON DELETE CASCADE,
        kind          TEXT NOT NULL,
        source_label  TEXT NOT NULL,
        content       TEXT NOT NULL,
        content_hash  TEXT NOT NULL,
        meta_json     TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_coder_session_inputs_session
        ON coder_session_inputs(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_coder_session_inputs_dedup
        ON coder_session_inputs(session_id, kind, content_hash);
    `);
  },
};
