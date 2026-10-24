/**
 * Migration 128 — durable compaction boundary (manual "summarize & clear" + the
 * durable side of automatic compaction).
 *
 * `coder_sessions.summary_boundary_id`: when set, every message loader (runner
 * seed + dashboard GET) only returns rows with `id > summary_boundary_id`.
 * NULL = no boundary (show the full transcript — the default for every existing
 * session). Older rows stay in the table (recoverable / "view earlier history").
 *
 * `coder_sessions.compaction_summary`: the rendered summary text covering the
 * hidden head. The runner PREPENDS it to its loaded history so the model starts
 * from the summary; the dashboard renders it as a "conversation summary" card.
 *
 * Unlike the in-memory auto-compaction (undone on the next fresh runner that
 * re-reads the full log), this pair is durable — it persists across runs and
 * server restarts, so the reduced context (and its cost) carries forward.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const sessionSummaryBoundary128: Migration = {
  version: 128,
  name: 'session_summary_boundary',
  up: (db: DB): void => {
    db.exec(`ALTER TABLE coder_sessions ADD COLUMN summary_boundary_id INTEGER;`);
    db.exec(`ALTER TABLE coder_sessions ADD COLUMN compaction_summary TEXT;`);
  },
};
