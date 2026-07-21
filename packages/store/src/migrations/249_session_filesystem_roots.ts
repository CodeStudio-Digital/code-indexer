/** Additional filesystem roots explicitly authorized for one coder session. */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const sessionFilesystemRoots249: Migration = {
  version: 249,
  name: 'session_filesystem_roots',
  up(db: DB): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS coder_session_filesystem_roots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES coder_sessions(id) ON DELETE CASCADE,
        root_path TEXT NOT NULL,
        access TEXT NOT NULL CHECK (access IN ('read', 'write')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(session_id, root_path)
      );

      CREATE INDEX IF NOT EXISTS idx_coder_session_filesystem_roots_session
        ON coder_session_filesystem_roots(session_id, id);
    `);
  },
};
