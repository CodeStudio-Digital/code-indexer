/**
 * Migration 108 — coder_task_runs + coder_task_run_items.
 *
 * Pin invariants:
 *   - Both tables exist with the columns the orchestrator writes (PR-B)
 *     and the columns reserved for PR-C/PR-D/PR-E.
 *   - Indexes by session_id, run_id, status, task_id (dashboard queries).
 *   - PK (run_id, task_id, attempt) — attempt ≥ 0 enables PR-C retry rows.
 *   - Idempotent — second `up()` run is a no-op.
 *   - Cascade delete: dropping a session row removes its runs + items.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { coderSessions004 } from '../004_coder_sessions.js';
import { coderTaskRuns108 } from '../108_coder_task_runs.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // 004 creates coder_sessions which 108 references via FK.
  coderSessions004.up(db);
});

afterEach(() => {
  db.close();
});

describe('migration 108 — coder_task_runs', () => {
  it('creates coder_task_runs with expected columns', () => {
    coderTaskRuns108.up(db);
    const cols = db
      .prepare(`PRAGMA table_info(coder_task_runs)`)
      .all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    for (const n of [
      'run_id', 'session_id', 'mode', 'started_at', 'finished_at', 'status',
      'total_input_tokens', 'total_output_tokens',
      'total_cache_read_tokens', 'total_cache_creation_tokens',
      'budget_tokens', 'budget_usd_cents', 'reject_reason',
      'created_at', 'updated_at',
    ]) {
      expect(names.has(n), `missing column ${n}`).toBe(true);
    }
  });

  it('creates coder_task_run_items with PR-B/C/D columns', () => {
    coderTaskRuns108.up(db);
    const cols = db
      .prepare(`PRAGMA table_info(coder_task_run_items)`)
      .all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    for (const n of [
      'run_id', 'task_id', 'attempt', 'wave_idx', 'parallel_group',
      'kind', 'title', 'started_at', 'finished_at', 'status',
      'tool_call_count', 'input_tokens', 'output_tokens',
      'inputs_fingerprint', 'skip_reason', 'error', 'summary',
    ]) {
      expect(names.has(n), `missing column ${n}`).toBe(true);
    }
  });

  it('creates indexes for the dashboard queries', () => {
    coderTaskRuns108.up(db);
    const idx = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index'`)
      .all() as Array<{ name: string }>;
    const names = new Set(idx.map((i) => i.name));
    expect(names.has('idx_coder_task_runs_session')).toBe(true);
    expect(names.has('idx_coder_task_runs_status')).toBe(true);
    expect(names.has('idx_coder_task_run_items_run')).toBe(true);
    expect(names.has('idx_coder_task_run_items_task')).toBe(true);
    expect(names.has('idx_coder_task_run_items_status')).toBe(true);
  });

  it('PK (run_id, task_id, attempt) — distinct attempts coexist', () => {
    coderTaskRuns108.up(db);
    db.prepare(`INSERT INTO coder_sessions (project_id, title, provider, model) VALUES (1, 't', 'p', 'm')`).run();
    const sid = (db.prepare('SELECT id FROM coder_sessions').get() as { id: number }).id;
    db.prepare(`
      INSERT INTO coder_task_runs (run_id, session_id, mode, started_at, status)
      VALUES ('r1', ?, 'auto', '2026-01-01', 'running')
    `).run(sid);
    const ins = db.prepare(`
      INSERT INTO coder_task_run_items
        (run_id, task_id, attempt, wave_idx, kind, title, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    // attempt 0 + attempt 1 for the same task → both rows persist.
    ins.run('r1', 'tsk_a', 0, 1, 'implement', 'A first', 'failed');
    ins.run('r1', 'tsk_a', 1, 1, 'implement', 'A retry', 'done');
    const rows = db.prepare('SELECT attempt FROM coder_task_run_items ORDER BY attempt').all() as { attempt: number }[];
    expect(rows.map((r) => r.attempt)).toEqual([0, 1]);
  });

  it('rejects duplicate PK', () => {
    coderTaskRuns108.up(db);
    db.prepare(`INSERT INTO coder_sessions (project_id, title, provider, model) VALUES (1, 't', 'p', 'm')`).run();
    const sid = (db.prepare('SELECT id FROM coder_sessions').get() as { id: number }).id;
    db.prepare(`INSERT INTO coder_task_runs (run_id, session_id, mode, started_at, status) VALUES ('r1', ?, 'auto', '2026', 'running')`).run(sid);
    const ins = db.prepare(`INSERT INTO coder_task_run_items (run_id, task_id, attempt, wave_idx, kind, title, status) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    ins.run('r1', 'tsk_a', 0, 1, 'implement', 'A', 'done');
    expect(() => ins.run('r1', 'tsk_a', 0, 1, 'implement', 'A2', 'done')).toThrow();
  });

  it('is idempotent — second up() run is a no-op', () => {
    coderTaskRuns108.up(db);
    expect(() => coderTaskRuns108.up(db)).not.toThrow();
  });

  it('cascade-deletes runs + items when a session is deleted', () => {
    coderTaskRuns108.up(db);
    db.prepare(`INSERT INTO coder_sessions (project_id, title, provider, model) VALUES (1, 't', 'p', 'm')`).run();
    const sid = (db.prepare('SELECT id FROM coder_sessions').get() as { id: number }).id;
    db.prepare(`INSERT INTO coder_task_runs (run_id, session_id, mode, started_at, status) VALUES ('r1', ?, 'auto', '2026', 'running')`).run(sid);
    db.prepare(`INSERT INTO coder_task_run_items (run_id, task_id, attempt, wave_idx, kind, title, status) VALUES ('r1', 'tsk_a', 0, 1, 'implement', 'A', 'done')`).run();
    db.prepare(`DELETE FROM coder_sessions WHERE id = ?`).run(sid);
    expect(db.prepare('SELECT COUNT(*) as c FROM coder_task_runs').get()).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) as c FROM coder_task_run_items').get()).toEqual({ c: 0 });
  });
});
