/**
 * Migration 088 — `recovered_at` + `recovered_reason` on company_sessions.
 *
 * P15c: when the server restarts, `recoverStaleAgentRuns()` flips every
 * `running` company_session to `paused`. The dashboard had no way to
 * tell those apart from sessions the user manually paused. Add two
 * nullable columns so the recovery sweep can stamp them; the
 * `SessionHeader` component renders a "Recovered — send a message to
 * resume" pill when `recovered_at` is non-null. The pill clears when
 * the session next transitions out of paused (next user message).
 *
 * Two columns instead of one because the reason text helps the user
 * understand WHY ("server restart", future: "OOM kill", "deploy") — a
 * single boolean would lose that signal.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function columnExists(db: DB, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((r) => r.name === column);
}

export const companySessionRecoveredAt091: Migration = {
  version: 91,
  name: 'company_session_recovered_at',
  up: (db: DB): void => {
    if (!columnExists(db, 'company_sessions', 'recovered_at')) {
      db.exec(`ALTER TABLE company_sessions ADD COLUMN recovered_at TEXT`);
    }
    if (!columnExists(db, 'company_sessions', 'recovered_reason')) {
      db.exec(`ALTER TABLE company_sessions ADD COLUMN recovered_reason TEXT`);
    }
  },
};
