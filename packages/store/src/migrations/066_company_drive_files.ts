/**
 * Migration 066 — Company shared drive.
 *
 * A persistent file drive scoped to a company (template) so all sessions
 * spawned from the same template share an artifact pool. Sessions without
 * a template fall back to per-session scope. Lets agents exchange large
 * documents (specs, dumps, reports) without polluting the inbox/board
 * with multi-KB messages.
 *
 * Storage split:
 *   - Metadata (path, owner, size, mime, timestamps) lives here.
 *   - File bytes live on disk under `<dataDir>/company-drives/<scope_key>/<storage_filename>`.
 *
 * `scope_key` format: `tpl:<template_id>` or `ses:<company_session_id>`.
 * UNIQUE(scope_key, path) enforces that overwriting a logical path updates
 * the same row in place.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const companyDriveFiles066: Migration = {
  version: 66,
  name: 'company_drive_files',
  up(db: DB) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS company_drive_files (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        scope_key          TEXT NOT NULL,
        path               TEXT NOT NULL,
        storage_filename   TEXT NOT NULL,
        size_bytes         INTEGER NOT NULL,
        mime               TEXT NOT NULL DEFAULT 'text/plain',
        owner_role         TEXT,
        owner_agent_run_id INTEGER
                             REFERENCES company_agent_runs(id) ON DELETE SET NULL,
        created_at         TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(scope_key, path)
      );

      CREATE INDEX IF NOT EXISTS idx_drive_scope
        ON company_drive_files(scope_key);
      CREATE INDEX IF NOT EXISTS idx_drive_scope_path
        ON company_drive_files(scope_key, path);
    `);
  },
};
