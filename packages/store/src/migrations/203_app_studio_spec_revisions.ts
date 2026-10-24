/**
 * App Studio spec evolution history.
 *
 * `app_studio_sessions.spec_json` remains the current cache used by the
 * builder. These tables add the missing product timeline: immutable spec
 * revisions plus user-facing evolutions that explain why a revision exists.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const appStudioSpecRevisions203: Migration = {
  version: 203,
  name: 'app_studio_spec_revisions',
  up(db: DB) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_studio_spec_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_session_id INTEGER NOT NULL REFERENCES app_studio_sessions(id) ON DELETE CASCADE,
        revision_number INTEGER NOT NULL,
        base_revision_id INTEGER REFERENCES app_studio_spec_revisions(id) ON DELETE SET NULL,
        status TEXT NOT NULL CHECK(status IN ('draft','approved','superseded','rejected')) DEFAULT 'draft',
        title TEXT,
        summary TEXT,
        change_reason TEXT,
        spec_json TEXT NOT NULL,
        diff_json TEXT,
        impact_json TEXT,
        created_by TEXT NOT NULL DEFAULT 'system',
        coder_session_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        approved_at TEXT,
        UNIQUE(app_session_id, revision_number)
      );

      CREATE INDEX IF NOT EXISTS idx_app_studio_spec_revisions_session
        ON app_studio_spec_revisions(app_session_id, revision_number DESC);

      CREATE INDEX IF NOT EXISTS idx_app_studio_spec_revisions_base
        ON app_studio_spec_revisions(base_revision_id);

      CREATE TABLE IF NOT EXISTS app_studio_evolutions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_session_id INTEGER NOT NULL REFERENCES app_studio_sessions(id) ON DELETE CASCADE,
        base_revision_id INTEGER REFERENCES app_studio_spec_revisions(id) ON DELETE SET NULL,
        proposed_revision_id INTEGER REFERENCES app_studio_spec_revisions(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL CHECK(status IN ('draft','review','approved','applied','rejected')) DEFAULT 'draft',
        impact_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        submitted_at TEXT,
        approved_at TEXT,
        applied_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_app_studio_evolutions_session
        ON app_studio_evolutions(app_session_id, created_at DESC);
    `);
  },
};
