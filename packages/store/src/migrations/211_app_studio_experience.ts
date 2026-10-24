import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const appStudioExperience211: Migration = {
  version: 211,
  name: 'app_studio_experience',
  up(db: DB) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_studio_ux_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_session_id INTEGER NOT NULL REFERENCES app_studio_sessions(id) ON DELETE CASCADE,
        spec_revision_id INTEGER REFERENCES app_studio_spec_revisions(id) ON DELETE SET NULL,
        architecture_revision_id INTEGER REFERENCES app_studio_architecture_revisions(id) ON DELETE SET NULL,
        revision_number INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('draft','approved','superseded','rejected')) DEFAULT 'draft',
        data_fingerprint TEXT NOT NULL,
        ux_json TEXT NOT NULL,
        created_by TEXT NOT NULL DEFAULT 'agent',
        coder_session_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        approved_at TEXT,
        UNIQUE(app_session_id, revision_number)
      );

      CREATE TABLE IF NOT EXISTS app_studio_wireframe_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_session_id INTEGER NOT NULL REFERENCES app_studio_sessions(id) ON DELETE CASCADE,
        spec_revision_id INTEGER REFERENCES app_studio_spec_revisions(id) ON DELETE SET NULL,
        architecture_revision_id INTEGER REFERENCES app_studio_architecture_revisions(id) ON DELETE SET NULL,
        ux_revision_id INTEGER REFERENCES app_studio_ux_revisions(id) ON DELETE SET NULL,
        revision_number INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('draft','approved','superseded','rejected')) DEFAULT 'draft',
        data_fingerprint TEXT NOT NULL,
        wireframe_json TEXT NOT NULL,
        created_by TEXT NOT NULL DEFAULT 'agent',
        coder_session_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        approved_at TEXT,
        UNIQUE(app_session_id, revision_number)
      );

      CREATE TABLE IF NOT EXISTS app_studio_build_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_session_id INTEGER NOT NULL REFERENCES app_studio_sessions(id) ON DELETE CASCADE,
        wireframe_revision_id INTEGER NOT NULL REFERENCES app_studio_wireframe_revisions(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','active','review','approved')) DEFAULT 'pending',
        summary TEXT,
        feedback TEXT,
        submitted_at TEXT,
        approved_at TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(wireframe_revision_id, group_id)
      );

      CREATE TABLE IF NOT EXISTS app_studio_build_task_evidence (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_session_id INTEGER NOT NULL REFERENCES app_studio_sessions(id) ON DELETE CASCADE,
        wireframe_revision_id INTEGER NOT NULL REFERENCES app_studio_wireframe_revisions(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','active','done')) DEFAULT 'pending',
        summary TEXT,
        evidence_json TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(wireframe_revision_id, task_id)
      );

      CREATE INDEX IF NOT EXISTS idx_app_studio_ux_session ON app_studio_ux_revisions(app_session_id, revision_number DESC);
      CREATE INDEX IF NOT EXISTS idx_app_studio_wireframe_session ON app_studio_wireframe_revisions(app_session_id, revision_number DESC);
      CREATE INDEX IF NOT EXISTS idx_app_studio_build_groups_revision ON app_studio_build_groups(wireframe_revision_id, group_id);
      CREATE INDEX IF NOT EXISTS idx_app_studio_build_tasks_revision ON app_studio_build_task_evidence(wireframe_revision_id, task_id);
    `);
  },
};
