/**
 * 067 — Replace `company_fronts` (migration 065) with sub-sessions.
 *
 * Multi-front via parent_session_id: every "front" is a full
 * `CompanySession` linked to a parent. The parent IS the Main tab; sub-
 * sessions are siblings linked via `parent_session_id`. This collapses
 * the per-front bookkeeping introduced by 065 (4 columns + 1 table +
 * cross-cutting filters in every service) into the existing
 * `company_session_id` FK that already isolates board / agent_runs /
 * master_prompts / inbox by session. Zero new isolation surface — the
 * row-level FK already does the job.
 *
 * Steps (single transaction in the migration runner):
 *   1. Add `company_sessions.parent_session_id INTEGER` (NULL = root).
 *   2. Backfill from 065:
 *      - default fronts (is_default=1): no-op (the parent session
 *        already owns those rows; only `front_id` was labelling them).
 *      - non-default + non-archived fronts: create a new `company_sessions`
 *        row with `parent_session_id` pointing at the front's session,
 *        then move every `company_agent_runs/board/master_prompts/inbox`
 *        row carrying `front_id = F.id` to the new session by setting
 *        their `company_session_id = newId`.
 *      - non-default + archived fronts: same as above, but mark the new
 *        sub-session as `completed` and stamp a stub
 *        `company_session_archives` row so the dashboard's archived tab
 *        keeps the data accessible.
 *   3. Drop `front_id` column from `company_agent_runs`, `company_board`,
 *      `company_master_prompts`, `agent_inbox` (SQLite ≥ 3.35 supports
 *      `DROP COLUMN` natively; we run on better-sqlite3 12.x → SQLite 3.45+).
 *   4. Drop `company_fronts` table.
 *
 * Result: zero data loss. Single-front (post-065) sessions are unchanged
 * (no children, only the parent row carries everything). Sessions with
 * extra fronts surface them as proper child `company_sessions` whose
 * runtime state reuses every existing isolation guarantee.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function hasColumn(db: DB, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function tableExists(db: DB, table: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(table) as { name: string } | undefined;
  return !!row;
}

interface FrontRow {
  id: number;
  company_session_id: number;
  label: string;
  status: string;
  master_session_id: number | null;
  is_default: number;
  archived_at: string | null;
}

export const companySubsessions067: Migration = {
  version: 67,
  name: 'company_subsessions',
  up(db: DB) {
    // ── 1. Add parent_session_id column + index ─────────────────────
    if (!hasColumn(db, 'company_sessions', 'parent_session_id')) {
      db.exec(
        `ALTER TABLE company_sessions
           ADD COLUMN parent_session_id INTEGER REFERENCES company_sessions(id) ON DELETE CASCADE`,
      );
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_company_sessions_parent
        ON company_sessions(parent_session_id);
    `);

    // ── 2. Backfill from 065's company_fronts ───────────────────────
    // Only run when the 065 artifacts are present. A fresh DB built
    // post-066 won't have them and the backfill is a no-op.
    if (tableExists(db, 'company_fronts')) {
      const fronts = db
        .prepare(
          `SELECT id, company_session_id, label, status, master_session_id,
                  is_default, archived_at
           FROM company_fronts
           ORDER BY company_session_id, position, id`,
        )
        .all() as FrontRow[];

      const insertChild = db.prepare(
        `INSERT INTO company_sessions
           (template_id, name, status, master_session_id, config_json,
            parent_session_id, created_at, updated_at)
         SELECT
           template_id,
           ?,                                     -- new name (front label)
           ?,                                     -- new status
           ?,                                     -- carried master_session_id
           config_json,                           -- snapshot of parent's config
           id,                                    -- parent_session_id
           datetime('now'),
           datetime('now')
         FROM company_sessions
         WHERE id = ?`,
      );

      const moveAgentRuns = hasColumn(db, 'company_agent_runs', 'front_id')
        ? db.prepare(
            `UPDATE company_agent_runs
                SET company_session_id = ?
              WHERE front_id = ?`,
          )
        : null;
      const moveBoard = hasColumn(db, 'company_board', 'front_id')
        ? db.prepare(
            `UPDATE company_board
                SET company_session_id = ?
              WHERE front_id = ?`,
          )
        : null;
      const moveMasterPrompts =
        tableExists(db, 'company_master_prompts') &&
        hasColumn(db, 'company_master_prompts', 'front_id')
          ? db.prepare(
              `UPDATE company_master_prompts
                  SET company_session_id = ?
                WHERE front_id = ?`,
            )
          : null;
      const moveInbox =
        tableExists(db, 'agent_inbox') && hasColumn(db, 'agent_inbox', 'front_id')
          ? db.prepare(
              `UPDATE agent_inbox
                  SET company_session_id = ?
                WHERE front_id = ?`,
            )
          : null;
      const insertArchiveStub =
        tableExists(db, 'company_session_archives')
          ? db.prepare(
              `INSERT INTO company_session_archives
                 (company_session_id, reason, included_kanban, included_sandbox, stats_json)
               VALUES (?, 'migrated-from-front-archive', 0, 0, '{}')`,
            )
          : null;

      for (const f of fronts) {
        if (f.is_default === 1) {
          // Default front rows already live on the parent session — no
          // moves needed; the `front_id` column is about to be dropped.
          continue;
        }
        const archived = f.archived_at != null;
        const newStatus = archived ? 'completed' : (f.status || 'idle');
        const result = insertChild.run(
          f.label,
          newStatus,
          f.master_session_id,
          f.company_session_id, // FROM company_sessions WHERE id = ?
        );
        const newSessionId = Number(result.lastInsertRowid);

        if (moveAgentRuns) moveAgentRuns.run(newSessionId, f.id);
        if (moveBoard) moveBoard.run(newSessionId, f.id);
        if (moveMasterPrompts) moveMasterPrompts.run(newSessionId, f.id);
        if (moveInbox) moveInbox.run(newSessionId, f.id);

        if (archived && insertArchiveStub) {
          insertArchiveStub.run(newSessionId);
        }
      }
    }

    // ── 3. Drop the front_id columns. SQLite 3.35+ supports DROP COLUMN. ─
    const dropFrontId = (table: string) => {
      if (tableExists(db, table) && hasColumn(db, table, 'front_id')) {
        // Indexes referencing the column must be dropped first; SQLite
        // raises an error otherwise. The 065 migration created the
        // following two; remove them defensively (IF EXISTS is safe).
        db.exec(`DROP INDEX IF EXISTS idx_company_agent_runs_front`);
        db.exec(`DROP INDEX IF EXISTS idx_company_board_front`);
        db.exec(`ALTER TABLE ${table} DROP COLUMN front_id`);
      }
    };
    dropFrontId('company_agent_runs');
    dropFrontId('company_board');
    dropFrontId('company_master_prompts');
    dropFrontId('agent_inbox');

    // ── 4. Drop the now-empty company_fronts table ──────────────────
    db.exec(`DROP TABLE IF EXISTS company_fronts`);
  },
};
