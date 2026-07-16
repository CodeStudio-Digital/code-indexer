import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { appStudioV6Reset237 } from '../237_app_studio_v6_reset.js';

function dbWithLegacySchema() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (id INTEGER PRIMARY KEY);
    CREATE TABLE coder_sessions (id INTEGER PRIMARY KEY);
    CREATE TABLE company_sessions (
      id INTEGER PRIMARY KEY,
      runtime_kind TEXT NOT NULL DEFAULT 'company',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE company_agent_runs (id INTEGER PRIMARY KEY);
    CREATE TABLE app_studio_sessions (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      app_slug TEXT NOT NULL
    );
  `);
  return db;
}

describe('migration 237 App Studio v6 reset', () => {
  it('refuses to erase an existing App', () => {
    const db = dbWithLegacySchema();
    db.exec("INSERT INTO app_studio_sessions VALUES (1, 1, 'Legacy', 'legacy')");
    expect(() => appStudioV6Reset237.up(db)).toThrow(/Delete all Apps and App teams first/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM app_studio_sessions').get()).toEqual({ n: 1 });
  });

  it('refuses to erase an orphaned App-owned Company team', () => {
    const db = dbWithLegacySchema();
    db.exec("INSERT INTO company_sessions (id, runtime_kind) VALUES (9, 'app_studio')");
    expect(() => appStudioV6Reset237.up(db)).toThrow(/apps=0, teams=1/);
    expect(db.prepare('SELECT runtime_kind FROM company_sessions WHERE id = 9').get()).toEqual({ runtime_kind: 'app_studio' });
  });

  it('creates only the v6 control-plane schema after a clean reset', () => {
    const db = dbWithLegacySchema();
    appStudioV6Reset237.up(db);
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
    expect(tables.has('app_studio_plan_revisions')).toBe(true);
    expect(tables.has('app_studio_deployments')).toBe(true);
    expect(tables.has('app_studio_approvals')).toBe(false);
    expect(tables.has('app_studio_product_revisions')).toBe(false);
  });
});
