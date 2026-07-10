import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const appStudioArchitecture204: Migration = {
  version: 204,
  name: 'app_studio_architecture',
  up(db: DB) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_studio_architecture_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_session_id INTEGER NOT NULL REFERENCES app_studio_sessions(id) ON DELETE CASCADE,
        spec_revision_id INTEGER REFERENCES app_studio_spec_revisions(id) ON DELETE SET NULL,
        revision_number INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('draft','approved','superseded','rejected')) DEFAULT 'draft',
        architecture_json TEXT NOT NULL,
        created_by TEXT NOT NULL DEFAULT 'agent',
        coder_session_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        approved_at TEXT,
        UNIQUE(app_session_id, revision_number)
      );

      CREATE INDEX IF NOT EXISTS idx_app_studio_architecture_session
        ON app_studio_architecture_revisions(app_session_id, revision_number DESC);
      CREATE INDEX IF NOT EXISTS idx_app_studio_architecture_spec
        ON app_studio_architecture_revisions(spec_revision_id);
    `);
  },
};
