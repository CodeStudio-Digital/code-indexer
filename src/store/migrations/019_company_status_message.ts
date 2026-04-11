/**
 * Migration 019 — Add status_message to company_agent_runs + relax status CHECK.
 *
 * SQLite cannot ALTER CHECK constraints. We recreate the table with the
 * expanded status enum and add a status_message column for human-readable
 * status descriptions (e.g., "Waiting for next task", "Working on campaigns").
 */
import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export const companyStatusMessage019 = {
  version: 19,
  name: 'company_status_message',
  up(db: DB) {
    // Add status_message column (idempotent)
    db.exec(`
      ALTER TABLE company_agent_runs ADD COLUMN status_message TEXT NOT NULL DEFAULT '';
    `);

    // Recreate table with expanded CHECK (SQLite workaround)
    db.exec(`
      CREATE TABLE IF NOT EXISTS company_agent_runs_new (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        company_session_id INTEGER NOT NULL REFERENCES company_sessions(id) ON DELETE CASCADE,
        role               TEXT NOT NULL,
        coder_session_id   INTEGER NOT NULL REFERENCES coder_sessions(id) ON DELETE CASCADE,
        project_ids_json   TEXT NOT NULL DEFAULT '[]',
        provider           TEXT NOT NULL,
        model              TEXT NOT NULL,
        status             TEXT NOT NULL DEFAULT 'idle'
                             CHECK(status IN ('idle','running','working','waiting','waiting_plan','reviewing','blocked','completed','error','aborted')),
        status_message     TEXT NOT NULL DEFAULT '',
        created_at         TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
      );

      INSERT OR IGNORE INTO company_agent_runs_new
        (id, company_session_id, role, coder_session_id, project_ids_json, provider, model, status, status_message, created_at, updated_at)
      SELECT id, company_session_id, role, coder_session_id, project_ids_json, provider, model, status, COALESCE(status_message, ''), created_at, updated_at
      FROM company_agent_runs;

      DROP TABLE company_agent_runs;
      ALTER TABLE company_agent_runs_new RENAME TO company_agent_runs;

      CREATE INDEX IF NOT EXISTS idx_car_session ON company_agent_runs(company_session_id);
    `);
  },
};
