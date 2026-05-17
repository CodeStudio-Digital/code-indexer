/**
 * Migration 038 — company session archives.
 *
 * Adds a `company_session_archives` table and `archive_id` columns on
 * the tables that carry per-session conversation state (agent_runs,
 * board, master_prompts, kanban_cards). `NULL` = active; non-NULL =
 * belongs to that archived snapshot.
 *
 * Why: the operator iterates on master/subordinate system prompts and
 * template role definitions, but existing running sessions stay
 * "crystallized" with the code that was live when they were created.
 * A Reset Session action now archives all current conversation state
 * (stamping `archive_id`) and flips the session back to `idle`, so the
 * next prompt renders a fresh master agent_run with the current code.
 *
 * All existing listing queries must add `AND archive_id IS NULL` to
 * hide archived rows from the active views. See `company-store.ts`.
 *
 * Coder messages are intentionally NOT touched: they are reached via
 * `coder_session_id` already stored on each agent_run, so an archived
 * agent_run still points to its intact message history.
 */
import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export const companyArchives038 = {
  version: 38,
  name: 'company_archives',
  up(db: DB) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS company_session_archives (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        company_session_id INTEGER NOT NULL
          REFERENCES company_sessions(id) ON DELETE CASCADE,
        archived_at        TEXT NOT NULL DEFAULT (datetime('now')),
        reason             TEXT,
        included_kanban    INTEGER NOT NULL DEFAULT 0,
        included_sandbox   INTEGER NOT NULL DEFAULT 0,
        stats_json         TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_archives_session_time
        ON company_session_archives(company_session_id, archived_at DESC);

      ALTER TABLE company_agent_runs     ADD COLUMN archive_id INTEGER
        REFERENCES company_session_archives(id) ON DELETE SET NULL;
      ALTER TABLE company_board          ADD COLUMN archive_id INTEGER
        REFERENCES company_session_archives(id) ON DELETE SET NULL;
      ALTER TABLE company_master_prompts ADD COLUMN archive_id INTEGER
        REFERENCES company_session_archives(id) ON DELETE SET NULL;
      ALTER TABLE kanban_cards           ADD COLUMN archive_id INTEGER
        REFERENCES company_session_archives(id) ON DELETE SET NULL;

      CREATE INDEX IF NOT EXISTS idx_agent_runs_archive
        ON company_agent_runs(archive_id);
      CREATE INDEX IF NOT EXISTS idx_board_archive
        ON company_board(archive_id);
      CREATE INDEX IF NOT EXISTS idx_kanban_archive
        ON kanban_cards(archive_id);
    `);
  },
};
