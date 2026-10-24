/**
 * Migration 154 — Per-root file snapshots for global (multi-project) sessions.
 *
 * `session_file_baselines` (migration 079) keyed an active baseline by
 * (session_kind, session_id, file_path). In a GLOBAL session one agent edits
 * files across several projects, so the SAME relative path (e.g. `src/index.ts`)
 * can exist in two roots within ONE session — which would collide on that
 * unique key and, worse, attribute a secondary-root edit to the primary root's
 * baseline (wrong diff / wrong revert target).
 *
 * Fix: add a nullable `project_id` and fold it into the active-uniqueness index.
 *
 * Backward compatibility:
 *   - Every existing baseline row is `session_kind = 'coder'` (the recorder is
 *     only ever constructed with that kind), so we BACKFILL `project_id` from
 *     the owning session's primary project. After the backfill a normal
 *     (single-project) session has exactly one project_id across all its
 *     baselines, so the widened unique index behaves identically to the old one
 *     — no duplicate baselines, no behavioural change for existing sessions.
 *   - The diff/revert resolver falls back to the session's project when a row's
 *     `project_id` is NULL (any stray legacy/company row), so nothing breaks.
 *
 * See: ports/snapshot-recording-filesystem-port.ts (records project_id),
 *      services/session-snapshots.ts (resolves the root from the baseline row).
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const snapshotProjectScope154: Migration = {
  version: 154,
  name: 'snapshot_project_scope',
  up: (db: DB): void => {
    addColumnIfMissing(db, 'session_file_baselines', 'project_id', 'INTEGER');

    // Backfill from the owning coder session's primary project. Idempotent:
    // only fills rows still NULL. Small table (one row per edited file/session).
    db.exec(`
      UPDATE session_file_baselines
         SET project_id = (
           SELECT cs.project_id FROM coder_sessions cs
            WHERE cs.id = session_file_baselines.session_id
         )
       WHERE session_kind = 'coder' AND project_id IS NULL;
    `);

    // Recreate the active-uniqueness index to include project_id, so the same
    // relative path in two roots within one global session no longer collides.
    // After the backfill every existing active row has a project_id, so this
    // CREATE cannot fail on current data.
    db.exec(`DROP INDEX IF EXISTS idx_sfb_active;`);
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sfb_active
        ON session_file_baselines(session_kind, session_id, project_id, file_path)
        WHERE status = 'active';
    `);
  },
};
