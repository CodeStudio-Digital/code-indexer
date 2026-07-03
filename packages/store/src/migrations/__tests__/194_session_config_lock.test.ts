/**
 * Migration 194 — session_config_lock.
 *
 * Pin invariants:
 *   - On a CENTRAL DB (coder_sessions present) up() adds
 *     session_config_lock_json and is idempotent.
 *   - On a PROJECT DB (coder_sessions trimmed away) up() is a no-op, not a
 *     crash. Without the tableExists guard the ALTER threw
 *     `no such table: coder_sessions` during project schema init.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { sessionConfigLock194 } from '../194_session_config_lock.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

function colNames(table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
});

afterEach(() => {
  db.close();
});

describe('migration 194 — session_config_lock', () => {
  it('no-ops when coder_sessions is absent (trimmed project DB)', () => {
    expect(colNames('coder_sessions')).toEqual([]);
    expect(() => sessionConfigLock194.up(db)).not.toThrow();
    expect(colNames('coder_sessions')).toEqual([]);
  });

  it('adds session_config_lock_json when coder_sessions exists (central DB)', () => {
    db.exec(`CREATE TABLE coder_sessions (id INTEGER PRIMARY KEY)`);
    sessionConfigLock194.up(db);
    expect(colNames('coder_sessions')).toContain('session_config_lock_json');
  });

  it('is idempotent — a second up() run is a no-op', () => {
    db.exec(`CREATE TABLE coder_sessions (id INTEGER PRIMARY KEY)`);
    sessionConfigLock194.up(db);
    expect(() => sessionConfigLock194.up(db)).not.toThrow();
    expect(colNames('coder_sessions').filter((c) => c === 'session_config_lock_json')).toHaveLength(1);
  });
});
