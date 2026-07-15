/** Migration 226 — sticky extended-thinking toggle per coder session. */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const sessionThinkingEnabled226: Migration = {
  version: 226,
  name: 'session_thinking_enabled',
  up(db: DB): void {
    const table = db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'coder_sessions'`,
    ).get();
    if (!table) return;

    const columns = db.prepare(`PRAGMA table_info(coder_sessions)`).all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === 'thinking_enabled')) return;
    db.exec(`
      ALTER TABLE coder_sessions
      ADD COLUMN thinking_enabled INTEGER NOT NULL DEFAULT 0
      CHECK (thinking_enabled IN (0, 1));
    `);
  },
};
