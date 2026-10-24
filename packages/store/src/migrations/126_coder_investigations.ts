/**
 * Migration 126 — Investigation ledger (Session Drive).
 *
 * Durable, browsable digests of sub-agent (`spawn_agent`) explorations,
 * auto-captured when a sub-agent finishes. PROJECT-scoped so a later
 * session can reuse an earlier session's investigation instead of
 * re-running the same query — the agent calls `recall_investigations`
 * before spawning a fresh explore.
 *
 * Complements `sub_agent_result_cache` (migration 081): that table is the
 * fast exact-match + TTL replay layer; THIS ledger is permanent and
 * keyword-recallable, surviving well past the cache TTL and surfaced in
 * the Session Drive panel.
 *
 * `project_id` / `session_id` are kept as loose INTEGERs (matching 081's
 * approach) so a row survives even if the originating session is deleted;
 * recall scopes by `project_id` when present, else `session_id`.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const coderInvestigations126: Migration = {
  version: 126,
  name: 'coder_investigations',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS coder_investigations (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id    INTEGER,
        session_id    INTEGER,
        topic         TEXT NOT NULL,
        summary       TEXT NOT NULL,
        body          TEXT NOT NULL DEFAULT '',
        source_label  TEXT,
        agent_type    TEXT,
        tokens        INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_coder_investigations_project
        ON coder_investigations(project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_coder_investigations_session
        ON coder_investigations(session_id, created_at DESC);
    `);
  },
};
