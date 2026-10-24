/** Migration 258 — coalesced manual agent transition pending the next run. */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const pendingAgentTransition258: Migration = {
  version: 258,
  name: 'pending_agent_transition',
  up(db: DB): void {
    const sessionsTable = db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'coder_sessions'`,
    ).get();
    if (!sessionsTable) return;

    db.exec(`
      CREATE TABLE IF NOT EXISTS coder_pending_agent_transitions (
        session_id INTEGER PRIMARY KEY
          REFERENCES coder_sessions(id) ON DELETE CASCADE,
        from_agent TEXT,
        to_agent TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  },
};
