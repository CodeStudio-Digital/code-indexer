/**
 * Migration 222 — immutable per-user-round file snapshots.
 *
 * The existing session_file_baselines table remains the cumulative, global
 * review/rollback source. Round snapshots are a second layer used by the chat
 * turn summary so later edits cannot change an older turn's diff.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function tableExists(db: DB, table: string): boolean {
  return !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
  ).get(table);
}

function columnExists(db: DB, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((entry) => entry.name === column);
}

export const coderRoundFileSnapshots222: Migration = {
  version: 222,
  name: 'coder_round_file_snapshots',
  up(db: DB): void {
    // Per-project DBs are trimmed after the central schema is created. On a
    // later upgrade this migration still runs there, but the snapshot tables
    // have already been removed and must remain central-only.
    if (!tableExists(db, 'session_file_baselines')) return;

    // `content_before` is intentionally omitted for oversized/binary baselines
    // because it feeds the line diff. Keep a separate full rollback payload so
    // disabling the visual diff never disables restoration.
    if (!columnExists(db, 'session_file_baselines', 'rollback_content')) {
      db.exec('ALTER TABLE session_file_baselines ADD COLUMN rollback_content TEXT');
    }
    db.exec(`
      UPDATE session_file_baselines
         SET rollback_content = content_before
       WHERE rollback_content IS NULL AND content_before IS NOT NULL;

      CREATE TABLE IF NOT EXISTS session_file_round_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_kind TEXT NOT NULL,
        session_id INTEGER NOT NULL,
        round_message_id INTEGER NOT NULL,
        global_baseline_id INTEGER NOT NULL
          REFERENCES session_file_baselines(id) ON DELETE CASCADE,
        project_id INTEGER,
        file_path TEXT NOT NULL,
        content_before TEXT,
        existed_before INTEGER NOT NULL,
        content_after TEXT,
        existed_after INTEGER NOT NULL,
        oversized INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_edited_at TEXT NOT NULL DEFAULT (datetime('now')),
        closed_at TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_sfrs_round_file
        ON session_file_round_snapshots(
          session_kind, session_id, round_message_id, COALESCE(project_id, -1), file_path
        );

      CREATE INDEX IF NOT EXISTS idx_sfrs_round
        ON session_file_round_snapshots(session_kind, session_id, round_message_id, status);

      CREATE INDEX IF NOT EXISTS idx_sfrs_global_baseline
        ON session_file_round_snapshots(global_baseline_id);

      CREATE TABLE IF NOT EXISTS session_file_round_hunk_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        round_snapshot_id INTEGER NOT NULL
          REFERENCES session_file_round_snapshots(id) ON DELETE CASCADE,
        hunk_fingerprint TEXT NOT NULL,
        decision TEXT NOT NULL,
        decided_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_sfrhd_unique
        ON session_file_round_hunk_decisions(round_snapshot_id, hunk_fingerprint);

      CREATE TABLE IF NOT EXISTS session_file_round_review_findings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        round_snapshot_id INTEGER NOT NULL
          REFERENCES session_file_round_snapshots(id) ON DELETE CASCADE,
        hunk_fingerprint TEXT,
        old_line INTEGER,
        new_line INTEGER,
        severity TEXT,
        body TEXT NOT NULL,
        suggested_fix TEXT,
        diff_excerpt TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_sfrrf_snapshot
        ON session_file_round_review_findings(round_snapshot_id, id);
    `);
  },
};
