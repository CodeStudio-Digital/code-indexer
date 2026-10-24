/**
 * Migration 010 — Session favorites (pin-to-top).
 *
 * Adds:
 *   - coder_sessions.is_favorite  (0/1)
 *   - coder_sessions.favorited_at (TEXT, nullable)
 *   - idx_coder_sessions_project_favorite_updated
 *
 * Additive and idempotent.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const sessionFavorites010: Migration = {
  version: 10,
  name: 'session_favorites',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'coder_sessions', 'is_favorite', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'coder_sessions', 'favorited_at', 'TEXT');
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_coder_sessions_project_favorite_updated
        ON coder_sessions(project_id, is_favorite DESC, updated_at DESC);
    `);
  },
};
