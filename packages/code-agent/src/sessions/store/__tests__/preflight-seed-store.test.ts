/**
 * Migration 180 + `setPreflightSeed`: the cached task-preflight seed column
 * round-trips and clears back to NULL. This is what makes `maybeRunPreflight`
 * idempotent (compute once) while still delivering the seed to the agent on a
 * later fresh POST.
 */
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { coderSessions004 } from '@mcp/store/migrations/004_coder_sessions.js';
import { sessionPreflightSeed180 } from '@mcp/store/migrations/180_session_preflight_seed.js';
import { setPreflightSeed } from '../sessions-state.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

function mkSession(): number {
  db.prepare(`INSERT INTO coder_sessions (project_id, title, provider, model) VALUES (1, 't', 'p', 'm')`).run();
  return Number((db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
}

function seedOf(id: number): string | null {
  return (db.prepare('SELECT preflight_seed_json FROM coder_sessions WHERE id = ?').get(id) as {
    preflight_seed_json: string | null;
  }).preflight_seed_json;
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(`CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY, name TEXT)`);
  db.exec(`INSERT INTO projects (id, name) VALUES (1, 'one')`);
  coderSessions004.up(db);
  sessionPreflightSeed180.up(db);
});
afterEach(() => db.close());

describe('migration 180 + setPreflightSeed', () => {
  it('adds the column idempotently (re-running is a no-op)', () => {
    expect(() => sessionPreflightSeed180.up(db)).not.toThrow();
    const cols = (db.prepare(`PRAGMA table_info(coder_sessions)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('preflight_seed_json');
  });

  it('defaults to NULL', () => {
    expect(seedOf(mkSession())).toBeNull();
  });

  it('round-trips a JSON seed and clears back to NULL', () => {
    const id = mkSession();
    const seed = JSON.stringify({ taskKind: 'edit', profile: 'navigate', pinTools: ['edit_file'] });
    setPreflightSeed(db, id, seed);
    expect(seedOf(id)).toBe(seed);
    // The cached seed survives a re-read verbatim (what maybeRunPreflight reuses).
    expect(JSON.parse(seedOf(id) ?? 'null')).toEqual({ taskKind: 'edit', profile: 'navigate', pinTools: ['edit_file'] });
    setPreflightSeed(db, id, null);
    expect(seedOf(id)).toBeNull();
  });
});
