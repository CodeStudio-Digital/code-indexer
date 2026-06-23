/**
 * Migration 018 — Company Agents Mode.
 *
 * Adds tables for multi-agent "company" orchestration: templates define
 * reusable role configurations, sessions link 1+ projects with N agent
 * runners, and a shared board enables cross-agent communication.
 */
import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export const companyAgents018 = {
  version: 18,
  name: 'company_agents',
  up(db: DB) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS company_templates (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        roles_json  TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS company_sessions (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        template_id       INTEGER REFERENCES company_templates(id) ON DELETE SET NULL,
        name              TEXT NOT NULL,
        status            TEXT NOT NULL DEFAULT 'idle'
                            CHECK(status IN ('idle','running','paused','completed','error')),
        master_session_id INTEGER REFERENCES coder_sessions(id) ON DELETE SET NULL,
        config_json       TEXT NOT NULL DEFAULT '{}',
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS company_session_projects (
        company_session_id INTEGER NOT NULL REFERENCES company_sessions(id) ON DELETE CASCADE,
        project_id         INTEGER NOT NULL,
        label              TEXT,
        PRIMARY KEY (company_session_id, project_id)
      );

      CREATE TABLE IF NOT EXISTS company_agent_runs (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        company_session_id INTEGER NOT NULL REFERENCES company_sessions(id) ON DELETE CASCADE,
        role               TEXT NOT NULL,
        coder_session_id   INTEGER NOT NULL REFERENCES coder_sessions(id) ON DELETE CASCADE,
        project_ids_json   TEXT NOT NULL DEFAULT '[]',
        provider           TEXT NOT NULL,
        model              TEXT NOT NULL,
        status             TEXT NOT NULL DEFAULT 'idle'
                             CHECK(status IN ('idle','running','waiting_plan','completed','error','aborted')),
        created_at         TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_car_session
        ON company_agent_runs(company_session_id);

      CREATE TABLE IF NOT EXISTS company_board (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        company_session_id INTEGER NOT NULL REFERENCES company_sessions(id) ON DELETE CASCADE,
        author_role        TEXT NOT NULL,
        agent_run_id       INTEGER REFERENCES company_agent_runs(id) ON DELETE SET NULL,
        kind               TEXT NOT NULL DEFAULT 'message',
        content            TEXT NOT NULL,
        mentions_json      TEXT NOT NULL DEFAULT '[]',
        created_at         TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_board_session
        ON company_board(company_session_id);
      CREATE INDEX IF NOT EXISTS idx_board_ts
        ON company_board(company_session_id, created_at);
    `);
  },
};
