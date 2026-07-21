import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { setReasoningEffort } from '../sessions-state.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE coder_sessions (
      id INTEGER PRIMARY KEY,
      execution_mode_override TEXT NOT NULL DEFAULT 'standard',
      reasoning_effort_override TEXT,
      updated_at TEXT
    );
    INSERT INTO coder_sessions (id) VALUES (1);
  `);
});

afterEach(() => db?.close());

describe('setReasoningEffort execution-mode compatibility', () => {
  it('converts future direct Ultra writes instead of persisting a wire effort', () => {
    setReasoningEffort(db, 1, ' Ultra ');

    expect(db.prepare(`
      SELECT execution_mode_override AS mode, reasoning_effort_override AS effort
        FROM coder_sessions WHERE id = 1
    `).get()).toEqual({ mode: 'ultra', effort: null });
  });

  it('keeps native efforts as provider settings', () => {
    setReasoningEffort(db, 1, ' high ');

    expect(db.prepare(`
      SELECT execution_mode_override AS mode, reasoning_effort_override AS effort
        FROM coder_sessions WHERE id = 1
    `).get()).toEqual({ mode: 'standard', effort: 'high' });
  });
});
