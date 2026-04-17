/**
 * Migration 031 — Persist the selected agent preset on coder_sessions.
 *
 * Without this column the agent (explore/plan/build/admin) only lived on the
 * HTTP request body. Resume paths (/continue after plan approval or ask_user
 * answer) didn't re-send it, so the runner's "has history → full tier"
 * fallback silently promoted the session and let Explore/Plan edit files.
 * Storing the agent lets the runner honour the user's choice across turns.
 */
import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export const coderSessionAgent031 = {
  version: 31,
  name: 'coder_session_agent',
  up(db: DB) {
    db.exec(`
      ALTER TABLE coder_sessions
        ADD COLUMN agent TEXT;
    `);
  },
};
