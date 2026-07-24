import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { pendingAgentTransition258 } from '../258_pending_agent_transition.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
});

afterEach(() => db?.close());

describe('migration 258 — pending manual agent transition', () => {
  it('is a no-op when coder_sessions is absent', () => {
    expect(() => pendingAgentTransition258.up(db)).not.toThrow();
  });

  it('creates one cascade-owned pending transition per session idempotently', () => {
    db.exec(`
      CREATE TABLE coder_sessions (id INTEGER PRIMARY KEY);
      INSERT INTO coder_sessions (id) VALUES (1);
    `);

    pendingAgentTransition258.up(db);
    pendingAgentTransition258.up(db);
    db.prepare(`
      INSERT INTO coder_pending_agent_transitions
        (session_id, from_agent, to_agent)
      VALUES (1, 'explore', 'build')
    `).run();

    expect(db.prepare(`
      SELECT session_id, from_agent, to_agent
        FROM coder_pending_agent_transitions
    `).all()).toEqual([{
      session_id: 1,
      from_agent: 'explore',
      to_agent: 'build',
    }]);

    db.prepare('DELETE FROM coder_sessions WHERE id = 1').run();
    expect(db.prepare('SELECT COUNT(*) AS count FROM coder_pending_agent_transitions').get())
      .toEqual({ count: 0 });
  });
});
