/**
 * Migration 079 — Per-session file snapshots with hunk-level keep/undo.
 *
 * Captures a baseline (pre-session content) for every file mutated by an
 * agent within a session, so the user can review the cumulative diff via a
 * git-diff-style UI and accept or revert individual hunks. The "after" side
 * of the diff is always the current on-disk content, recomputed on demand —
 * we only persist the immutable baseline plus per-hunk decisions.
 *
 * Tables:
 *   - session_file_baselines: one active row per (session, file) holding the
 *     content snapshot taken before the session's first edit to that file.
 *     Status transitions: 'active' → 'closed_kept' | 'closed_reverted'.
 *
 *   - session_file_edits: append-only audit log; one row per agent mutation.
 *     Lets the UI break down what happened per turn without bloating the
 *     baseline row.
 *
 *   - session_file_hunk_decisions: persistent per-hunk verdicts keyed by a
 *     content fingerprint stable as long as the agent doesn't re-edit the
 *     same region. Re-editing invalidates the fingerprint and forces
 *     re-review, which is intended.
 *
 * See: src/core/coder/ports/snapshot-recording-filesystem-port.ts (capture),
 *      src/core/services/session-snapshots.ts (queries + revert logic),
 *      src/apps/dashboard/features/snapshots/* (UI).
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const sessionFileSnapshots079: Migration = {
  version: 79,
  name: 'session_file_snapshots',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_file_baselines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_kind TEXT NOT NULL,
        session_id INTEGER NOT NULL,
        file_path TEXT NOT NULL,
        content_before TEXT,
        existed_before INTEGER NOT NULL,
        baseline_hash TEXT NOT NULL,
        oversized INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        first_seen_at TEXT NOT NULL,
        last_edited_at TEXT NOT NULL,
        closed_at TEXT
      );
    `);

    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sfb_active
        ON session_file_baselines(session_kind, session_id, file_path)
        WHERE status = 'active';
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sfb_session
        ON session_file_baselines(session_kind, session_id, status);
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS session_file_edits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        baseline_id INTEGER NOT NULL REFERENCES session_file_baselines(id) ON DELETE CASCADE,
        turn_number INTEGER,
        tool_name TEXT NOT NULL,
        content_after_hash TEXT NOT NULL,
        was_delete INTEGER NOT NULL DEFAULT 0,
        applied_at TEXT NOT NULL
      );
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sfe_baseline
        ON session_file_edits(baseline_id);
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS session_file_hunk_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        baseline_id INTEGER NOT NULL REFERENCES session_file_baselines(id) ON DELETE CASCADE,
        hunk_fingerprint TEXT NOT NULL,
        decision TEXT NOT NULL,
        decided_at TEXT NOT NULL
      );
    `);

    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sfhd_unique
        ON session_file_hunk_decisions(baseline_id, hunk_fingerprint);
    `);
  },
};
