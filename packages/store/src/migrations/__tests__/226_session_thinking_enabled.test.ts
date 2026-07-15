import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { sessionThinkingEnabled226 } from '../226_session_thinking_enabled.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

beforeEach(() => { db = new Database(':memory:'); });
afterEach(() => db.close());

describe('migration 226 — session thinking state', () => {
  it('is a no-op for trimmed databases without coder_sessions', () => {
    expect(() => sessionThinkingEnabled226.up(db)).not.toThrow();
  });

  it('adds an idempotent boolean column defaulting existing sessions to off', () => {
    db.exec(`
      CREATE TABLE coder_sessions (id INTEGER PRIMARY KEY, title TEXT NOT NULL);
      INSERT INTO coder_sessions (id, title) VALUES (1, 'existing');
    `);

    sessionThinkingEnabled226.up(db);
    sessionThinkingEnabled226.up(db);

    const row = db.prepare('SELECT thinking_enabled FROM coder_sessions WHERE id = 1')
      .get() as { thinking_enabled: number };
    expect(row.thinking_enabled).toBe(0);
    expect(() => db.prepare('UPDATE coder_sessions SET thinking_enabled = 2 WHERE id = 1').run()).toThrow();
  });
});
