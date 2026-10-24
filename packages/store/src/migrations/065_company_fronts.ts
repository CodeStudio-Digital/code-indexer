/**
 * 065 — Company Fronts (multi-master per session).
 *
 * A "front" is a sub-container inside a CompanySession with its own
 * master agent, board feed, composer and subordinate set, while sharing
 * the project, sandbox and services with sibling fronts.
 *
 * The user can open multiple fronts in one session and alternate
 * between them to parallelise unrelated work — while the master of
 * front A is blocked in `wait_for_subordinates`, the user switches to
 * front B and dispatches new work.
 *
 * Tables:
 *   - `company_fronts` — one row per front, with status + label.
 *
 * New `front_id` columns (nullable at the schema level for SQLite
 * compatibility — the runtime backfills them and treats them as
 * required from now on):
 *   - `company_agent_runs.front_id`
 *   - `company_board.front_id`
 *   - `company_master_prompts.front_id`
 *   - `agent_inbox.front_id`
 *
 * Backfill: for every existing `company_session`, create one default
 * front (label='Main', is_default=1) carrying the existing
 * `master_session_id`, then point all child rows to that front.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

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

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  if (!tableExists(db, table)) return;
  if (hasColumn(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

export const companyFronts065: Migration = {
  version: 65,
  name: 'company_fronts',
  up(db: DB) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS company_fronts (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        company_session_id  INTEGER NOT NULL REFERENCES company_sessions(id) ON DELETE CASCADE,
        label               TEXT NOT NULL,
        status              TEXT NOT NULL DEFAULT 'idle',
        master_session_id   INTEGER,
        is_default          INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
        position            INTEGER NOT NULL DEFAULT 0,
        archived_at         TEXT,
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_company_fronts_session
        ON company_fronts(company_session_id);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_company_fronts_session_active
        ON company_fronts(company_session_id, archived_at);
    `);

    addColumnIfMissing(db, 'company_agent_runs', 'front_id', 'front_id INTEGER');
    addColumnIfMissing(db, 'company_board',      'front_id', 'front_id INTEGER');
    addColumnIfMissing(db, 'company_master_prompts',     'front_id', 'front_id INTEGER');
    addColumnIfMissing(db, 'agent_inbox',        'front_id', 'front_id INTEGER');

    // ── Backfill ────────────────────────────────────────────────────
    // For every CompanySession that does not yet have a default front,
    // create one and migrate its existing master_session_id + child rows.
    const sessions = db
      .prepare(
        `SELECT cs.id, cs.master_session_id
         FROM company_sessions cs
         WHERE NOT EXISTS (
           SELECT 1 FROM company_fronts cf
           WHERE cf.company_session_id = cs.id AND cf.is_default = 1
         )`,
      )
      .all() as Array<{ id: number; master_session_id: number | null }>;

    const insertFront = db.prepare(
      `INSERT INTO company_fronts
         (company_session_id, label, status, master_session_id, is_default, position)
       VALUES (?, 'Main', 'idle', ?, 1, 0)`,
    );
    const updateAgentRuns = db.prepare(
      `UPDATE company_agent_runs SET front_id = ? WHERE company_session_id = ? AND front_id IS NULL`,
    );
    const updateBoard = db.prepare(
      `UPDATE company_board SET front_id = ? WHERE company_session_id = ? AND front_id IS NULL`,
    );
    const updateMasterPrompts = tableExists(db, 'company_master_prompts')
      ? db.prepare(
          `UPDATE company_master_prompts SET front_id = ? WHERE company_session_id = ? AND front_id IS NULL`,
        )
      : null;
    const updateInbox = tableExists(db, 'agent_inbox')
      ? db.prepare(
          `UPDATE agent_inbox SET front_id = ? WHERE company_session_id = ? AND front_id IS NULL`,
        )
      : null;

    for (const s of sessions) {
      const result = insertFront.run(s.id, s.master_session_id);
      const frontId = Number(result.lastInsertRowid);
      updateAgentRuns.run(frontId, s.id);
      updateBoard.run(frontId, s.id);
      if (updateMasterPrompts) updateMasterPrompts.run(frontId, s.id);
      if (updateInbox) updateInbox.run(frontId, s.id);
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_company_agent_runs_front ON company_agent_runs(front_id);
      CREATE INDEX IF NOT EXISTS idx_company_board_front      ON company_board(front_id);
    `);
  },
};
