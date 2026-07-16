import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { companyAgentRunLifecycleStatuses236 } from '../236_company_agent_run_lifecycle_statuses.js';

describe('migration 236 — Company agent-run lifecycle statuses', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => db.close());

  function createLegacyAgentSchema(withAppRuntime: boolean): void {
    db.exec(`
      CREATE TABLE coder_sessions (id INTEGER PRIMARY KEY);
      CREATE TABLE company_sessions (id INTEGER PRIMARY KEY);
      CREATE TABLE company_session_archives (id INTEGER PRIMARY KEY);
      CREATE TABLE company_agent_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_session_id INTEGER NOT NULL REFERENCES company_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        coder_session_id INTEGER NOT NULL REFERENCES coder_sessions(id) ON DELETE CASCADE,
        project_ids_json TEXT NOT NULL DEFAULT '[]',
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'idle'
          CHECK(status IN ('idle','running','working','waiting','waiting_plan','reviewing','blocked','completed','error','aborted')),
        status_message TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        archive_id INTEGER REFERENCES company_session_archives(id) ON DELETE SET NULL,
        configured_provider TEXT,
        configured_model TEXT,
        dispatch_source TEXT NOT NULL DEFAULT 'company',
        fallback_reason TEXT
      );
      CREATE INDEX idx_car_session ON company_agent_runs(company_session_id);
      CREATE INDEX idx_agent_runs_archive ON company_agent_runs(archive_id);
    `);
    if (!withAppRuntime) return;
    db.exec(`
      CREATE TABLE app_studio_sessions (
        id INTEGER PRIMARY KEY,
        company_session_id INTEGER REFERENCES company_sessions(id)
      );
      CREATE TABLE app_studio_work_items (
        app_session_id INTEGER NOT NULL,
        id TEXT NOT NULL,
        PRIMARY KEY (app_session_id, id)
      );
      CREATE TABLE app_studio_work_item_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_session_id INTEGER NOT NULL,
        work_item_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        role TEXT NOT NULL,
        company_agent_run_id INTEGER REFERENCES company_agent_runs(id) ON DELETE SET NULL,
        coder_session_id INTEGER,
        status TEXT NOT NULL DEFAULT 'claimed'
      );
      CREATE TRIGGER trg_app_studio_work_item_run_agent_insert
      BEFORE INSERT ON app_studio_work_item_runs
      WHEN NEW.company_agent_run_id IS NOT NULL
      BEGIN
        SELECT CASE WHEN NOT EXISTS (
          SELECT 1 FROM company_agent_runs WHERE id = NEW.company_agent_run_id
        ) THEN RAISE(ABORT, 'missing agent') END;
      END;
      CREATE TRIGGER trg_app_studio_work_item_run_agent_update
      BEFORE UPDATE OF company_agent_run_id ON app_studio_work_item_runs
      WHEN NEW.company_agent_run_id IS NOT NULL
      BEGIN
        SELECT CASE WHEN NOT EXISTS (
          SELECT 1 FROM company_agent_runs WHERE id = NEW.company_agent_run_id
        ) THEN RAISE(ABORT, 'missing agent') END;
      END;
    `);
  }

  it('preserves runs and App claims while enabling restart and pause statuses', () => {
    createLegacyAgentSchema(true);
    db.exec(`
      INSERT INTO coder_sessions (id) VALUES (10), (20);
      INSERT INTO company_sessions (id) VALUES (1), (2);
      INSERT INTO company_agent_runs
        (id, company_session_id, role, coder_session_id, provider, model, status,
         configured_provider, configured_model, dispatch_source)
      VALUES
        (1, 1, 'backend', 10, 'openai', 'gpt-backend', 'running', 'openai', 'gpt-backend', 'app_studio'),
        (2, 2, 'backend', 20, 'openai', 'gpt-other', 'waiting', 'openai', 'gpt-other', 'app_studio');
      INSERT INTO app_studio_sessions (id, company_session_id) VALUES (7, 1);
      INSERT INTO app_studio_work_items (app_session_id, id) VALUES (7, 'backend'), (7, 'frontend');
      INSERT INTO app_studio_work_item_runs
        (id, app_session_id, work_item_id, attempt, role, company_agent_run_id, coder_session_id, status)
      VALUES (30, 7, 'backend', 4, 'backend', 1, 10, 'running');
    `);

    companyAgentRunLifecycleStatuses236.up(db);
    companyAgentRunLifecycleStatuses236.up(db);

    expect(db.prepare(`
      SELECT id, company_session_id, coder_session_id, model, status, dispatch_source
      FROM company_agent_runs WHERE id = 1
    `).get()).toEqual({
      id: 1,
      company_session_id: 1,
      coder_session_id: 10,
      model: 'gpt-backend',
      status: 'running',
      dispatch_source: 'app_studio',
    });
    expect(db.prepare(`
      SELECT id, attempt, company_agent_run_id, coder_session_id, status
      FROM app_studio_work_item_runs WHERE id = 30
    `).get()).toEqual({
      id: 30,
      attempt: 4,
      company_agent_run_id: 1,
      coder_session_id: 10,
      status: 'running',
    });
    for (const status of ['paused', 'interrupted', 'waiting_question', 'waiting_tasks']) {
      expect(() => db.prepare('UPDATE company_agent_runs SET status = ? WHERE id = 1').run(status)).not.toThrow();
    }
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(() => db.exec(`
      INSERT INTO app_studio_work_item_runs
        (app_session_id, work_item_id, attempt, role, company_agent_run_id, coder_session_id)
      VALUES (7, 'frontend', 1, 'backend', 2, 20)
    `)).toThrow(/does not belong/);
  });

  it('does not require App tables in a partially trimmed database', () => {
    createLegacyAgentSchema(false);
    db.exec(`
      INSERT INTO coder_sessions (id) VALUES (10);
      INSERT INTO company_sessions (id) VALUES (1);
      INSERT INTO company_agent_runs
        (company_session_id, role, coder_session_id, provider, model)
      VALUES (1, 'master', 10, 'openai', 'gpt');
    `);

    expect(() => companyAgentRunLifecycleStatuses236.up(db)).not.toThrow();
    expect(() => db.prepare("UPDATE company_agent_runs SET status = 'interrupted'").run()).not.toThrow();
  });

  it('is a safe no-op after Company tables were trimmed', () => {
    db.exec('CREATE TABLE projects (id INTEGER PRIMARY KEY)');
    expect(() => companyAgentRunLifecycleStatuses236.up(db)).not.toThrow();
  });
});
