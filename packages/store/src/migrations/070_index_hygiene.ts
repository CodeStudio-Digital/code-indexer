/**
 * Migration 070 — Index hygiene.
 *
 * Three independent fixes that travel together because they all touch
 * vector bookkeeping:
 *
 *  1. Deduplicate `vector_ids` (project_id, vector_id) and add a unique
 *     index so future double-inserts fail loudly. The DB had ~35% dup
 *     rate on the dev machine.
 *  2. Normalize `files.language` to lowercase so filters stop splitting
 *     "typescript" vs "TypeScript" into two buckets.
 *  3. Mark long-running runs (`status='running'` for >24h) as 'abandoned'
 *     so health metrics stop counting them as in-flight.
 *
 * Also introduces:
 *  - `projects.pending_vector_gc` — flag set by the project-delete
 *    cascade when Vectorize rejects the deletion. The Hygiene panel
 *    uses it to retry.
 *  - `pending_vector_deletes` — queue of vector ids that need to be
 *    removed from the remote vector store but couldn't be at the time
 *    of project deletion. Independent of the projects table so a
 *    project can be removed cleanly even when Vectorize is unreachable.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const indexHygiene070: Migration = {
  version: 70,
  name: 'index_hygiene',
  up: (db: DB): void => {
    // ── 1. Dedup vector_ids ────────────────────────────────────────
    // Keep the highest id (most recent insert) per (project_id, vector_id).
    db.exec(`
      DELETE FROM vector_ids
      WHERE id NOT IN (
        SELECT MAX(id) FROM vector_ids GROUP BY project_id, vector_id
      );
    `);

    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_vector_ids_unique
        ON vector_ids(project_id, vector_id);
    `);

    // ── 2. Normalize file language casing ──────────────────────────
    db.exec(`
      UPDATE files
      SET language = LOWER(language)
      WHERE language <> LOWER(language);
    `);

    // ── 3. Close stale "running" runs ──────────────────────────────
    db.exec(`
      UPDATE runs
      SET status = 'abandoned',
          finished_at = COALESCE(finished_at, datetime('now'))
      WHERE status = 'running'
        AND started_at < datetime('now', '-24 hours');
    `);

    // ── 4. Project flag for failed remote vector deletes ───────────
    const cols = db
      .prepare("PRAGMA table_info(projects)")
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'pending_vector_gc')) {
      db.exec(
        `ALTER TABLE projects ADD COLUMN pending_vector_gc INTEGER NOT NULL DEFAULT 0;`,
      );
    }

    // ── 5. Retry queue for vector ids the worker rejected ──────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS pending_vector_deletes (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        vector_id     TEXT NOT NULL UNIQUE,
        project_name  TEXT,
        first_seen    TEXT NOT NULL DEFAULT (datetime('now')),
        last_attempt  TEXT,
        attempts      INTEGER NOT NULL DEFAULT 0,
        last_error    TEXT
      );
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_pending_vector_deletes_attempt
        ON pending_vector_deletes(last_attempt);
    `);
  },
};
