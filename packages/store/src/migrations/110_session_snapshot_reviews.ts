/**
 * Migration 110 — Review comments for per-session file snapshots.
 *
 * Stores manual and automatic review feedback attached to snapshot diffs.
 * Comments point at a baseline plus optional hunk/line coordinates so the
 * agent can receive precise, reviewable feedback in a later chat turn.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const sessionSnapshotReviews110: Migration = {
  version: 110,
  name: 'session_snapshot_reviews',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_file_review_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_kind TEXT NOT NULL,
        session_id INTEGER NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        provider_id TEXT,
        model_id TEXT,
        raw_response TEXT,
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_sfr_runs_session
        ON session_file_review_runs(session_kind, session_id, created_at);

      CREATE TABLE IF NOT EXISTS session_file_review_comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER REFERENCES session_file_review_runs(id) ON DELETE SET NULL,
        baseline_id INTEGER NOT NULL REFERENCES session_file_baselines(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        file_path TEXT NOT NULL,
        hunk_fingerprint TEXT,
        old_line INTEGER,
        new_line INTEGER,
        severity TEXT,
        body TEXT NOT NULL,
        suggested_fix TEXT,
        diff_excerpt TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_sfr_comments_baseline
        ON session_file_review_comments(baseline_id, status);

      CREATE INDEX IF NOT EXISTS idx_sfr_comments_run
        ON session_file_review_comments(run_id);
    `);
  },
};
