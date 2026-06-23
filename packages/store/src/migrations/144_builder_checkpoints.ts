/**
 * Migration 144 — visual checkpoint timeline for Builder projects.
 *
 * Every agent run-end (and bursts of visual edits) on a Builder project
 * lands a real git commit; this table is the UI index over those commits:
 * which ones are checkpoints, which session produced them, and the
 * preview screenshot captured right after (Electron-only, nullable).
 *
 * Restores never rewrite history — `git checkout <sha> -- .` + a new
 * commit — so rows are append-only and `commit_sha` may repeat.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const builderCheckpoints144: Migration = {
  version: 144,
  name: 'builder_checkpoints',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS builder_checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        session_id INTEGER,
        commit_sha TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL DEFAULT 'auto',
        screenshot_path TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_builder_checkpoints_project
        ON builder_checkpoints(project_id, id DESC);
    `);
  },
};
