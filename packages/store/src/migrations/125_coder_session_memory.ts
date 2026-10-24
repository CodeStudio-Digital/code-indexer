/**
 * Migration 125 — Session working memory (Session Drive).
 *
 * Per-session durable notes the agent writes via the `remember` tool and
 * that the dynamic injector re-surfaces after context compaction, so long
 * sessions don't forget the decisions/facts they established earlier.
 *
 * Distinct from project-memory (Mem C, migration 114 `snapshot_memory`):
 * that store is project-scoped + retrieval-ranked across sessions; THIS is
 * the session's own working scratchpad, also browsable in the Session
 * Drive panel.
 *
 * `kind` is a soft tag ('decision'|'fact'|'risk'|'todo') for UI grouping.
 * Title is unique per session so a repeated `remember` with the same title
 * updates instead of duplicating.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const coderSessionMemory125: Migration = {
  version: 125,
  name: 'coder_session_memory',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS coder_session_memory (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  INTEGER NOT NULL REFERENCES coder_sessions(id) ON DELETE CASCADE,
        kind        TEXT NOT NULL DEFAULT 'fact',
        title       TEXT NOT NULL,
        body        TEXT NOT NULL,
        pinned      INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_coder_session_memory_title
        ON coder_session_memory(session_id, title);
      CREATE INDEX IF NOT EXISTS idx_coder_session_memory_surface
        ON coder_session_memory(session_id, pinned, updated_at DESC);
    `);
  },
};
