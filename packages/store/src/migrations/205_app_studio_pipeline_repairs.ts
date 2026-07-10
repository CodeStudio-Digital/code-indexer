import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const appStudioPipelineRepairs205: Migration = {
  version: 205,
  name: 'app_studio_pipeline_repairs',
  up(db: DB) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_studio_pipeline_repairs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_session_id INTEGER NOT NULL REFERENCES app_studio_sessions(id) ON DELETE CASCADE,
        before_pipeline_json TEXT,
        after_pipeline_json TEXT NOT NULL,
        report_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        undone_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_app_studio_pipeline_repairs_session
        ON app_studio_pipeline_repairs(app_session_id, id DESC);
    `);
  },
};
