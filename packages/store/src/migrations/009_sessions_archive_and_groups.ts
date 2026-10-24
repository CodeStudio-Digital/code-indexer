/**
 * Migration 009 — Session groups and archive state.
 *
 * Adds:
 *   - coder_session_groups table (per-project folders for chat sessions)
 *   - coder_sessions.group_id  (nullable FK → coder_session_groups, ON DELETE SET NULL)
 *   - coder_sessions.is_archived (0/1)
 *   - coder_sessions.archived_at (TEXT, nullable)
 *   - idx_coder_sessions_project_archived_updated
 *
 * All additive and idempotent — uses PRAGMA table_info before ALTER TABLE.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const sessionsArchiveAndGroups009: Migration = {
  version: 9,
  name: 'sessions_archive_and_groups',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS coder_session_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        color TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_coder_session_groups_project
        ON coder_session_groups(project_id, sort_order);
    `);

    // SQLite ALTER TABLE ADD COLUMN cannot add a REFERENCES clause after the
    // fact in older SQLite versions, but better-sqlite3 (3.38+) accepts it.
    // Falls back gracefully: the app-level logic still enforces the relation.
    addColumnIfMissing(
      db,
      'coder_sessions',
      'group_id',
      'INTEGER REFERENCES coder_session_groups(id) ON DELETE SET NULL'
    );
    addColumnIfMissing(db, 'coder_sessions', 'is_archived', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'coder_sessions', 'archived_at', 'TEXT');

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_coder_sessions_project_archived_updated
        ON coder_sessions(project_id, is_archived, updated_at DESC);
    `);
  },
};
