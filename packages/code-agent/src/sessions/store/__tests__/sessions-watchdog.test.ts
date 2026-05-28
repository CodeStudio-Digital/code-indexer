/**
 * Frente E — periodic watchdog recovery (`recoverStuckRunning`).
 *
 * Locks in:
 *   - Sessions whose `updated_at` is FRESHER than the cutoff are LEFT
 *     ALONE (active sessions must not be disturbed by the periodic sweep).
 *   - Sessions whose `updated_at` is OLDER than the cutoff are flipped
 *     to `'idle'` (the watchdog's whole point).
 *   - The sweep is idempotent — running it twice on the same fixture
 *     touches zero rows the second time (because everything already
 *     went idle).
 *   - Sessions in non-active statuses (`completed`, `failed`) are never
 *     touched regardless of age.
 *
 * Uses the same in-memory better-sqlite3 pattern as the task-runs repo
 * tests — no mocking, real migrations, real SQL.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { coderSessions004 } from '@mcp/store/migrations/004_coder_sessions.js';
import { recoverStuckRunning } from '../sessions-core.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

beforeEach(() => {
  db = new Database(':memory:');
  // Keep FKs OFF so the test doesn't need the entire `projects` table
  // and friends — we only care about the coder_sessions row shape.
  db.pragma('foreign_keys = OFF');
  // Some migrations create FK constraints targeting tables not yet
  // present in an isolated in-memory DB; instantiate the bare minimum.
  db.exec(`CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY, name TEXT)`);
  db.exec(`INSERT INTO projects (id, name) VALUES (1, 'test')`);
  coderSessions004.up(db);
});

afterEach(() => {
  db.close();
});

function seed(status: string, updatedAt: string): number {
  const r = db.prepare(`
    INSERT INTO coder_sessions (project_id, title, provider, model, status, updated_at)
    VALUES (1, ?, 'p', 'm', ?, ?)
  `).run(`t-${status}-${updatedAt}`, status, updatedAt);
  return Number(r.lastInsertRowid);
}

function statusOf(id: number): string {
  return (db.prepare('SELECT status FROM coder_sessions WHERE id = ?').get(id) as { status: string }).status;
}

describe('recoverStuckRunning', () => {
  it('leaves fresh in_progress sessions alone', () => {
    const fresh = seed('in_progress', "datetime('now', '-30 seconds')");
    // Have to actually evaluate the expression in SQL — `INSERT … VALUES (datetime(...))`
    // needs raw SQL execution, not parameter binding.
    db.prepare('UPDATE coder_sessions SET updated_at = datetime(\'now\', \'-30 seconds\') WHERE id = ?').run(fresh);

    const recovered = recoverStuckRunning(db, { maxAgeMs: 10 * 60 * 1000 });
    expect(recovered).toBe(0);
    expect(statusOf(fresh)).toBe('in_progress');
  });

  it('recovers stale running sessions older than maxAgeMs', () => {
    const stale = seed('running', 'placeholder');
    db.prepare('UPDATE coder_sessions SET updated_at = datetime(\'now\', \'-20 minutes\') WHERE id = ?').run(stale);

    const recovered = recoverStuckRunning(db, { maxAgeMs: 10 * 60 * 1000 });
    expect(recovered).toBe(1);
    expect(statusOf(stale)).toBe('idle');
  });

  it('is idempotent — second sweep recovers zero', () => {
    const stale = seed('working', 'placeholder');
    db.prepare('UPDATE coder_sessions SET updated_at = datetime(\'now\', \'-20 minutes\') WHERE id = ?').run(stale);

    expect(recoverStuckRunning(db, { maxAgeMs: 10 * 60 * 1000 })).toBe(1);
    expect(recoverStuckRunning(db, { maxAgeMs: 10 * 60 * 1000 })).toBe(0);
    expect(statusOf(stale)).toBe('idle');
  });

  it('never touches terminal statuses regardless of age', () => {
    const completed = seed('completed', 'placeholder');
    const failed = seed('failed', 'placeholder');
    db.prepare('UPDATE coder_sessions SET updated_at = datetime(\'now\', \'-2 hours\') WHERE id IN (?, ?)').run(completed, failed);

    expect(recoverStuckRunning(db, { maxAgeMs: 10 * 60 * 1000 })).toBe(0);
    expect(statusOf(completed)).toBe('completed');
    expect(statusOf(failed)).toBe('failed');
  });

  it('honours a custom maxAgeMs (5 minutes)', () => {
    const sixMinOld = seed('in_progress', 'placeholder');
    db.prepare('UPDATE coder_sessions SET updated_at = datetime(\'now\', \'-6 minutes\') WHERE id = ?').run(sixMinOld);

    // Default 10min would leave it alone; 5min cutoff catches it.
    expect(recoverStuckRunning(db, { maxAgeMs: 5 * 60 * 1000 })).toBe(1);
    expect(statusOf(sixMinOld)).toBe('idle');
  });

  it('default maxAgeMs (10 minutes) when not provided', () => {
    const nineMinOld = seed('in_progress', 'placeholder');
    db.prepare('UPDATE coder_sessions SET updated_at = datetime(\'now\', \'-9 minutes\') WHERE id = ?').run(nineMinOld);

    // 9 min < default 10 min → no-op.
    expect(recoverStuckRunning(db)).toBe(0);
    expect(statusOf(nineMinOld)).toBe('in_progress');
  });
});
