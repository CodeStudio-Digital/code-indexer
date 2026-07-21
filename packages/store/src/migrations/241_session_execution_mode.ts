/** Migration 241 — universal execution mode, independent of provider effort. */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function columnsOf(db: DB): Array<{ name: string }> {
  return db.prepare('PRAGMA table_info(coder_sessions)').all() as Array<{ name: string }>;
}

export const sessionExecutionMode241: Migration = {
  version: 241,
  name: 'session_execution_mode',
  up(db: DB): void {
    const table = db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'coder_sessions'`,
    ).get();
    if (!table) return;

    let columns = columnsOf(db);
    if (!columns.some((column) => column.name === 'execution_mode_override')) {
      db.exec(`
        ALTER TABLE coder_sessions
        ADD COLUMN execution_mode_override TEXT NOT NULL DEFAULT 'standard'
        CHECK (execution_mode_override IN ('standard', 'ultra'));
      `);
      columns = columnsOf(db);
    }

    // Older builds exposed "ultra" as if it were a provider reasoning level.
    // Keep the user's intent while ensuring no unsupported effort reaches an API.
    if (columns.some((column) => column.name === 'reasoning_effort_override')) {
      db.prepare(`
        UPDATE coder_sessions
           SET execution_mode_override = 'ultra',
               reasoning_effort_override = NULL
         WHERE lower(trim(reasoning_effort_override)) = 'ultra'
      `).run();
    }
  },
};
