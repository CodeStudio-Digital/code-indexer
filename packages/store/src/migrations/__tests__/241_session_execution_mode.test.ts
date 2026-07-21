import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { sessionExecutionMode241 } from '../241_session_execution_mode.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

beforeEach(() => { db = new Database(':memory:'); });
afterEach(() => db?.close());

describe('migration 241 — universal session execution mode', () => {
  it('is a no-op for trimmed databases without coder_sessions', () => {
    expect(() => sessionExecutionMode241.up(db)).not.toThrow();
  });

  it('defaults to standard and migrates legacy ultra efforts idempotently', () => {
    db.exec(`
      CREATE TABLE coder_sessions (
        id INTEGER PRIMARY KEY,
        reasoning_effort_override TEXT,
        updated_at TEXT
      );
      INSERT INTO coder_sessions (id, reasoning_effort_override) VALUES
        (1, NULL),
        (2, 'high'),
        (3, 'ultra'),
        (4, '  ULTRA  ');
    `);

    sessionExecutionMode241.up(db);
    sessionExecutionMode241.up(db);

    const rows = db.prepare(`
      SELECT id, execution_mode_override AS mode, reasoning_effort_override AS effort
        FROM coder_sessions
       ORDER BY id
    `).all() as Array<{ id: number; mode: string; effort: string | null }>;
    expect(rows).toEqual([
      { id: 1, mode: 'standard', effort: null },
      { id: 2, mode: 'standard', effort: 'high' },
      { id: 3, mode: 'ultra', effort: null },
      { id: 4, mode: 'ultra', effort: null },
    ]);
    expect(() => db.prepare(
      `UPDATE coder_sessions SET execution_mode_override = 'turbo' WHERE id = 1`,
    ).run()).toThrow();
  });

  it('also supports old trimmed session tables without reasoning effort', () => {
    db.exec(`CREATE TABLE coder_sessions (id INTEGER PRIMARY KEY)`);
    sessionExecutionMode241.up(db);

    db.prepare('INSERT INTO coder_sessions (id) VALUES (1)').run();
    const row = db.prepare('SELECT execution_mode_override AS mode FROM coder_sessions WHERE id = 1')
      .get() as { mode: string };
    expect(row.mode).toBe('standard');
  });
});
