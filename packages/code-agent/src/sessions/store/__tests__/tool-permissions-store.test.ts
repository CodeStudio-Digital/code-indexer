/**
 * Migration 131 + the tool-permission setters: mode round-trip, idempotent
 * grant accumulation (including a corrupted column), and the watchdog
 * keep-alive touch.
 */
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { coderSessions004 } from '@mcp/store/migrations/004_coder_sessions.js';
import { sessionToolPermissions131 } from '@mcp/store/migrations/131_session_tool_permissions.js';
import { addToolPermissionGrant, setToolPermissionMode, touchSession } from '../sessions-state.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

function mkSession(): number {
  db.prepare(`INSERT INTO coder_sessions (project_id, title, provider, model) VALUES (1, 't', 'p', 'm')`).run();
  return Number((db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
}

function row(id: number): { tool_permission_mode: string | null; tool_permission_grants: string | null; updated_at: string } {
  return db.prepare('SELECT tool_permission_mode, tool_permission_grants, updated_at FROM coder_sessions WHERE id = ?')
    .get(id) as ReturnType<typeof row>;
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(`CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY, name TEXT)`);
  db.exec(`INSERT INTO projects (id, name) VALUES (1, 'one')`);
  coderSessions004.up(db);
  sessionToolPermissions131.up(db);
});
afterEach(() => db.close());

describe('migration 131 + tool-permission setters', () => {
  it('adds the columns idempotently (re-running is a no-op)', () => {
    expect(() => sessionToolPermissions131.up(db)).not.toThrow();
    const cols = (db.prepare(`PRAGMA table_info(coder_sessions)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('tool_permission_mode');
    expect(cols).toContain('tool_permission_grants');
  });

  it('mode round-trips and clears back to NULL', () => {
    const id = mkSession();
    expect(row(id).tool_permission_mode).toBeNull();
    setToolPermissionMode(db, id, 'ask');
    expect(row(id).tool_permission_mode).toBe('ask');
    setToolPermissionMode(db, id, null);
    expect(row(id).tool_permission_mode).toBeNull();
  });

  it('grants accumulate idempotently', () => {
    const id = mkSession();
    addToolPermissionGrant(db, id, 'run_command');
    addToolPermissionGrant(db, id, 'run_command');
    addToolPermissionGrant(db, id, 'git_commit');
    expect(JSON.parse(row(id).tool_permission_grants ?? '[]')).toEqual(['run_command', 'git_commit']);
  });

  it('rebuilds a corrupted grants column instead of crashing', () => {
    const id = mkSession();
    db.prepare('UPDATE coder_sessions SET tool_permission_grants = ? WHERE id = ?').run('{not json', id);
    addToolPermissionGrant(db, id, 'run_command');
    expect(JSON.parse(row(id).tool_permission_grants ?? '[]')).toEqual(['run_command']);
  });

  it('touchSession bumps updated_at (watchdog keep-alive)', () => {
    const id = mkSession();
    db.prepare(`UPDATE coder_sessions SET updated_at = '2000-01-01 00:00:00' WHERE id = ?`).run(id);
    touchSession(db, id);
    expect(row(id).updated_at).not.toBe('2000-01-01 00:00:00');
  });
});
