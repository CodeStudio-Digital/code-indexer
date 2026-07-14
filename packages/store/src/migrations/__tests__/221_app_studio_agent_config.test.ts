import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { appStudioAgentConfig221 } from '../221_app_studio_agent_config.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

beforeEach(() => { db = new Database(':memory:'); });
afterEach(() => db.close());

describe('migration 221 — App Studio agent configuration', () => {
  it('adds the persisted agent configuration without changing existing sessions', () => {
    db.exec('CREATE TABLE app_studio_sessions (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
    db.prepare('INSERT INTO app_studio_sessions (id, name) VALUES (1, ?)').run('Orders');

    appStudioAgentConfig221.up(db);

    const columns = db.prepare('PRAGMA table_info(app_studio_sessions)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain('agent_config_json');
    expect(db.prepare('SELECT id, name, agent_config_json FROM app_studio_sessions WHERE id = 1').get()).toEqual({
      id: 1,
      name: 'Orders',
      agent_config_json: null,
    });
  });

  it('is idempotent and safe for trimmed databases', () => {
    expect(() => appStudioAgentConfig221.up(db)).not.toThrow();
    db.exec('CREATE TABLE app_studio_sessions (id INTEGER PRIMARY KEY, agent_config_json TEXT)');
    expect(() => {
      appStudioAgentConfig221.up(db);
      appStudioAgentConfig221.up(db);
    }).not.toThrow();
    const columns = db.prepare('PRAGMA table_info(app_studio_sessions)').all() as Array<{ name: string }>;
    expect(columns.filter((column) => column.name === 'agent_config_json')).toHaveLength(1);
  });
});
