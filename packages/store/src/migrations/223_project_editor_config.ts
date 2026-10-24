/** Migration 223 — versioned per-project Monaco editor overrides. */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const projectEditorConfig223: Migration = {
  version: 223,
  name: 'project_editor_config',
  up(db: DB): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_editor_config (
        project_id INTEGER PRIMARY KEY,
        settings_json TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  },
};
