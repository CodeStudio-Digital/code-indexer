import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { consume, get, stage } from '../agent-transitions.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE coder_sessions (
      id INTEGER PRIMARY KEY,
      agent TEXT,
      updated_at TEXT
    );
    CREATE TABLE coder_pending_agent_transitions (
      session_id INTEGER PRIMARY KEY
        REFERENCES coder_sessions(id) ON DELETE CASCADE,
      from_agent TEXT,
      to_agent TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO coder_sessions (id, agent) VALUES (1, 'explore');
  `);
});

afterEach(() => db?.close());

describe('pending manual agent transitions', () => {
  it('coalesces repeated selections while preserving the original agent', () => {
    stage(db, 1, 'build');
    stage(db, 1, 'plan');

    expect(db.prepare('SELECT agent FROM coder_sessions WHERE id = 1').get())
      .toEqual({ agent: 'plan' });
    expect(get(db, 1)).toMatchObject({
      sessionId: 1,
      fromAgent: 'explore',
      toAgent: 'plan',
    });
  });

  it('cancels a pending transition when the selector returns to its origin', () => {
    stage(db, 1, 'build');
    stage(db, 1, 'explore');

    expect(get(db, 1)).toBeNull();
  });

  it('returns the final transition once when the next run consumes it', () => {
    stage(db, 1, null);

    expect(consume(db, 1)).toMatchObject({
      sessionId: 1,
      fromAgent: 'explore',
      toAgent: null,
    });
    expect(consume(db, 1)).toBeNull();
  });
});
