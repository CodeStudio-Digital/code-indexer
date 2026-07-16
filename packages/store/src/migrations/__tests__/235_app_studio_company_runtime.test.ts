import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appStudioCompanyRuntime235 } from '../235_app_studio_company_runtime.js';

describe('migration 235 — App Studio Company runtime', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => db.close());

  function createLegacyCentralSchema(): void {
    db.exec(`
      CREATE TABLE coder_sessions (id INTEGER PRIMARY KEY);
      CREATE TABLE company_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE company_agent_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_session_id INTEGER NOT NULL REFERENCES company_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'backend',
        coder_session_id INTEGER REFERENCES coder_sessions(id) ON DELETE SET NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL
      );
      CREATE TABLE app_studio_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT);
      CREATE TABLE app_studio_work_items (
        id TEXT NOT NULL,
        app_session_id INTEGER NOT NULL REFERENCES app_studio_sessions(id) ON DELETE CASCADE,
        PRIMARY KEY (app_session_id, id)
      );
    `);
  }

  it('adds runtime ownership and backfills configured model provenance idempotently', () => {
    createLegacyCentralSchema();
    const legacyCompanyId = Number(db.prepare("INSERT INTO company_sessions (name) VALUES ('legacy')").run().lastInsertRowid);
    db.prepare("INSERT INTO company_agent_runs (company_session_id, provider, model) VALUES (?, 'openai', 'gpt-main')")
      .run(legacyCompanyId);

    appStudioCompanyRuntime235.up(db);
    appStudioCompanyRuntime235.up(db);

    expect(db.prepare('SELECT runtime_kind FROM company_sessions WHERE id = ?').get(legacyCompanyId))
      .toEqual({ runtime_kind: 'company' });
    expect(db.prepare(`
      SELECT configured_provider, configured_model, dispatch_source, fallback_reason
      FROM company_agent_runs WHERE company_session_id = ?
    `).get(legacyCompanyId)).toEqual({
      configured_provider: 'openai',
      configured_model: 'gpt-main',
      dispatch_source: 'company',
      fallback_reason: null,
    });
  });

  it('requires a unique app_studio Company owner and protects it from direct deletion', () => {
    createLegacyCentralSchema();
    appStudioCompanyRuntime235.up(db);
    const normalId = Number(db.prepare("INSERT INTO company_sessions (name) VALUES ('normal')").run().lastInsertRowid);
    const appTeamId = Number(db.prepare("INSERT INTO company_sessions (name, runtime_kind) VALUES ('app', 'app_studio')").run().lastInsertRowid);
    const appA = Number(db.prepare('INSERT INTO app_studio_sessions DEFAULT VALUES').run().lastInsertRowid);
    const appB = Number(db.prepare('INSERT INTO app_studio_sessions DEFAULT VALUES').run().lastInsertRowid);

    expect(() => db.prepare('UPDATE app_studio_sessions SET company_session_id = ? WHERE id = ?').run(normalId, appA))
      .toThrow(/requires an app_studio Company session/);
    db.prepare('UPDATE app_studio_sessions SET company_session_id = ? WHERE id = ?').run(appTeamId, appA);
    expect(() => db.prepare('UPDATE app_studio_sessions SET company_session_id = ? WHERE id = ?').run(appTeamId, appB))
      .toThrow();
    expect(() => db.prepare("UPDATE company_sessions SET runtime_kind = 'company' WHERE id = ?").run(appTeamId))
      .toThrow(/Cannot change runtime kind/);
    expect(() => db.prepare('DELETE FROM company_sessions WHERE id = ?').run(appTeamId)).toThrow();
  });

  it('keeps one active attempt per work item while retaining terminal history', () => {
    createLegacyCentralSchema();
    appStudioCompanyRuntime235.up(db);
    db.exec(`
      INSERT INTO app_studio_sessions (id) VALUES (1);
      INSERT INTO app_studio_work_items (app_session_id, id) VALUES (1, 'backend');
      INSERT INTO app_studio_work_item_runs
        (app_session_id, work_item_id, attempt, role, idempotency_key)
      VALUES (1, 'backend', 1, 'backend', 'backend:1');
    `);

    expect(() => db.exec(`
      INSERT INTO app_studio_work_item_runs
        (app_session_id, work_item_id, attempt, role, idempotency_key)
      VALUES (1, 'backend', 2, 'backend', 'backend:2');
    `)).toThrow();

    db.exec("UPDATE app_studio_work_item_runs SET status = 'completed' WHERE idempotency_key = 'backend:1'");
    db.exec(`
      INSERT INTO app_studio_work_item_runs
        (app_session_id, work_item_id, attempt, role, idempotency_key)
      VALUES (1, 'backend', 2, 'backend', 'backend:2');
    `);
    expect(db.prepare('SELECT attempt, status FROM app_studio_work_item_runs ORDER BY attempt').all())
      .toEqual([{ attempt: 1, status: 'completed' }, { attempt: 2, status: 'claimed' }]);
  });

  it('accepts only an agent from the linked App team and configured role', () => {
    createLegacyCentralSchema();
    appStudioCompanyRuntime235.up(db);
    db.exec(`
      INSERT INTO coder_sessions (id) VALUES (10), (20);
      INSERT INTO company_sessions (id, name, runtime_kind) VALUES
        (1, 'App A', 'app_studio'),
        (2, 'App B', 'app_studio');
      INSERT INTO app_studio_sessions (id, company_session_id) VALUES (1, 1);
      INSERT INTO app_studio_work_items (app_session_id, id) VALUES
        (1, 'backend'), (1, 'frontend');
      INSERT INTO company_agent_runs
        (id, company_session_id, role, coder_session_id, provider, model)
      VALUES
        (1, 1, 'backend', 10, 'openai', 'gpt'),
        (2, 2, 'backend', 20, 'openai', 'gpt');
    `);

    expect(() => db.exec(`
      INSERT INTO app_studio_work_item_runs
        (app_session_id, work_item_id, attempt, role, company_agent_run_id, coder_session_id, idempotency_key)
      VALUES (1, 'backend', 1, 'backend', 2, 20, 'wrong-team');
    `)).toThrow(/does not belong/);
    expect(() => db.exec(`
      INSERT INTO app_studio_work_item_runs
        (app_session_id, work_item_id, attempt, role, company_agent_run_id, coder_session_id, idempotency_key)
      VALUES (1, 'backend', 1, 'frontend', 1, 10, 'wrong-role');
    `)).toThrow(/does not belong/);

    db.exec(`
      INSERT INTO app_studio_work_item_runs
        (app_session_id, work_item_id, attempt, role, company_agent_run_id, coder_session_id, idempotency_key)
      VALUES (1, 'backend', 1, 'backend', 1, 10, 'correct');
    `);
    expect(() => db.exec(`
      INSERT INTO app_studio_work_item_runs
        (app_session_id, work_item_id, attempt, role, company_agent_run_id, coder_session_id, idempotency_key)
      VALUES (1, 'frontend', 1, 'backend', 1, 10, 'same-active-agent');
    `)).toThrow();
  });

  it('is a safe no-op after central tables were trimmed from a project DB', () => {
    db.exec('CREATE TABLE projects (id INTEGER PRIMARY KEY)');
    expect(() => appStudioCompanyRuntime235.up(db)).not.toThrow();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_studio_work_item_runs'").get())
      .toBeUndefined();
  });
});
