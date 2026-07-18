import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { coderSessions004 } from '@mcp/store/migrations/004_coder_sessions.js';
import { coderPlans007 } from '@mcp/store/migrations/007_coder_plans.js';
import * as plans from '../plans.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;
let firstSessionId: number;
let secondSessionId: number;

function createSession(title: string): number {
  const result = db.prepare(
    "INSERT INTO coder_sessions (project_id, title, provider, model) VALUES (1, ?, 'test', 'test')",
  ).run(title);
  return Number(result.lastInsertRowid);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec('CREATE TABLE projects (id INTEGER PRIMARY KEY)');
  db.prepare('INSERT INTO projects (id) VALUES (1)').run();
  coderSessions004.up(db);
  coderPlans007.up(db);
  firstSessionId = createSession('first');
  secondSessionId = createSession('second');
});

afterEach(() => db.close());

describe('resolveLatestPending', () => {
  it('resolves only the newest pending plan in the selected session', () => {
    plans.record(db, { session_id: firstSessionId, tool_use_id: 'internal-old', plan_text: 'old' });
    plans.record(db, { session_id: firstSessionId, tool_use_id: 'internal-current', plan_text: 'current' });
    plans.record(db, { session_id: secondSessionId, tool_use_id: 'internal-other', plan_text: 'other' });

    expect(plans.resolveLatestPending(db, firstSessionId, 'approved', 'ok')).toBe(true);

    expect(plans.list(db, firstSessionId).map(({ tool_use_id, status, feedback }) => ({
      tool_use_id,
      status,
      feedback,
    }))).toEqual([
      { tool_use_id: 'internal-current', status: 'approved', feedback: 'ok' },
      { tool_use_id: 'internal-old', status: 'pending', feedback: null },
    ]);
    expect(plans.list(db, secondSessionId)[0]?.status).toBe('pending');
  });

  it('returns false when the session has no pending plan', () => {
    plans.record(db, { session_id: firstSessionId, tool_use_id: 'internal', plan_text: 'done' });
    plans.resolve(db, 'internal', 'approved');

    expect(plans.resolveLatestPending(db, firstSessionId, 'rejected')).toBe(false);
    expect(plans.list(db, firstSessionId)[0]?.status).toBe('approved');
  });
});
