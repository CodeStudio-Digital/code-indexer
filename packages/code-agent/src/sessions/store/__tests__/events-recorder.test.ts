/**
 * Onda 3d (Codex parity): append-only session_events log (migration 195).
 * recordSessionEvent appends; listSessionEvents reads newest-first + filters;
 * writes are best-effort (no throw when the table is absent).
 */
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { sessionEvents195 } from '@mcp/store/migrations/195_session_events.js';
import { recordSessionEvent, listSessionEvents } from '../events-recorder.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

beforeEach(() => {
  db = new Database(':memory:');
  sessionEvents195.up(db);
});
afterEach(() => db.close());

describe('session_events recorder', () => {
  it('appends and lists newest-first', () => {
    recordSessionEvent(db, { session_id: 1, kind: 'session_created', to_state: 'a/b', actor: 'system', at_ms: 100 });
    recordSessionEvent(db, { session_id: 1, kind: 'goal_changed', to_state: 'in_progress', actor: 'agent', at_ms: 200 });
    const rows = listSessionEvents(db, 1);
    expect(rows.map((r) => r.kind)).toEqual(['goal_changed', 'session_created']);
    expect(rows[1].to_state).toBe('a/b');
  });

  it('filters by kind and scopes by session', () => {
    recordSessionEvent(db, { session_id: 1, kind: 'config_drift', reason: 'model changed', actor: 'resume', at_ms: 10 });
    recordSessionEvent(db, { session_id: 2, kind: 'config_drift', actor: 'resume', at_ms: 20 });
    const rows = listSessionEvents(db, 1, { kind: 'config_drift' });
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe('model changed');
  });

  it('is best-effort: never throws when the table is missing', () => {
    const bare = new Database(':memory:');
    try {
      expect(() => recordSessionEvent(bare, { session_id: 1, kind: 'session_created', actor: 'system' })).not.toThrow();
    } finally {
      bare.close();
    }
  });
});
