/**
 * Repo CRUD for `coder_task_runs` + `coder_task_run_items` (PR-B).
 *
 * These exercise the pure repo functions (createRun, updateRun,
 * upsertItem, listRunsBySession, getRunWithItems, recoverRunningRuns)
 * against a freshly migrated in-memory SQLite. The bridge layer
 * (task-run-persistence.ts) sits on top of these — its hooks are
 * exercised separately in execute-tasks-persistence.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { coderSessions004 } from '@mcp/store/migrations/004_coder_sessions.js';
import { coderTaskRuns108 } from '@mcp/store/migrations/108_coder_task_runs.js';
import {
  createRun,
  updateRun,
  upsertItem,
  getRun,
  listRunsBySession,
  listItems,
  getRunWithItems,
  recoverRunningRuns,
} from '../task-runs.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;
let sessionId: number;

beforeEach(() => {
  db = new Database(':memory:');
  // FKs OFF — the migrations create constraints targeting `projects`
  // and other tables that aren't present in this minimal test DB.
  // Stub the projects row so existing FK assertions are content.
  db.pragma('foreign_keys = OFF');
  db.exec(`CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY, name TEXT)`);
  db.exec(`INSERT INTO projects (id, name) VALUES (1, 'test')`);
  coderSessions004.up(db);
  coderTaskRuns108.up(db);
  db.prepare(`INSERT INTO coder_sessions (project_id, title, provider, model) VALUES (1, 't', 'p', 'm')`).run();
  sessionId = (db.prepare('SELECT id FROM coder_sessions').get() as { id: number }).id;
});

afterEach(() => {
  db.close();
});

describe('task-runs repo CRUD', () => {
  it('createRun + getRun round-trip', () => {
    createRun(db, {
      run_id: 'r1', session_id: sessionId, mode: 'auto',
      started_at: '2026-01-01T00:00:00Z',
    });
    const row = getRun(db, 'r1');
    expect(row).not.toBeNull();
    expect(row?.status).toBe('running');
    expect(row?.mode).toBe('auto');
    expect(row?.session_id).toBe(sessionId);
    expect(row?.finished_at).toBeNull();
    expect(row?.budget_tokens).toBeNull();
  });

  it('updateRun transitions running → completed and writes totals', () => {
    createRun(db, { run_id: 'r1', session_id: sessionId, mode: 'auto', started_at: '2026-01-01' });
    updateRun(db, 'r1', {
      status: 'completed',
      finished_at: '2026-01-01T00:05:00Z',
      total_input_tokens: 1234,
      total_output_tokens: 567,
      total_cache_read_tokens: 89,
      total_cache_creation_tokens: 12,
    });
    const row = getRun(db, 'r1');
    expect(row?.status).toBe('completed');
    expect(row?.total_input_tokens).toBe(1234);
    expect(row?.total_output_tokens).toBe(567);
    expect(row?.total_cache_read_tokens).toBe(89);
    expect(row?.total_cache_creation_tokens).toBe(12);
  });

  it('upsertItem creates then updates (idempotent by PK)', () => {
    createRun(db, { run_id: 'r1', session_id: sessionId, mode: 'auto', started_at: '2026' });
    upsertItem(db, {
      run_id: 'r1', task_id: 'tsk_a', wave_idx: 1,
      kind: 'implement', title: 'A', status: 'running',
      started_at: '2026-01-01T00:01:00Z',
    });
    upsertItem(db, {
      run_id: 'r1', task_id: 'tsk_a', wave_idx: 1,
      kind: 'implement', title: 'A',
      status: 'done',
      finished_at: '2026-01-01T00:02:00Z',
      tool_call_count: 5,
      input_tokens: 100, output_tokens: 50,
      summary: 'Completed A',
    });
    const items = listItems(db, 'r1');
    expect(items.length).toBe(1); // one row, not duplicated
    expect(items[0].status).toBe('done');
    expect(items[0].started_at).toBe('2026-01-01T00:01:00Z'); // COALESCE preserved
    expect(items[0].finished_at).toBe('2026-01-01T00:02:00Z');
    expect(items[0].tool_call_count).toBe(5);
    expect(items[0].summary).toBe('Completed A');
  });

  it('upsertItem with distinct attempt creates separate rows (PR-C retry)', () => {
    createRun(db, { run_id: 'r1', session_id: sessionId, mode: 'auto', started_at: '2026' });
    upsertItem(db, { run_id: 'r1', task_id: 'tsk_a', attempt: 0, wave_idx: 1, kind: 'implement', title: 'A', status: 'failed' });
    upsertItem(db, { run_id: 'r1', task_id: 'tsk_a', attempt: 1, wave_idx: 1, kind: 'implement', title: 'A', status: 'done' });
    const items = listItems(db, 'r1');
    expect(items.length).toBe(2);
    expect(items.map((i) => i.attempt).sort()).toEqual([0, 1]);
  });

  it('listRunsBySession returns most-recent first', () => {
    createRun(db, { run_id: 'r1', session_id: sessionId, mode: 'auto', started_at: '2026-01-01T00:00:00Z' });
    createRun(db, { run_id: 'r2', session_id: sessionId, mode: 'auto', started_at: '2026-01-02T00:00:00Z' });
    createRun(db, { run_id: 'r3', session_id: sessionId, mode: 'auto', started_at: '2026-01-03T00:00:00Z' });
    const runs = listRunsBySession(db, sessionId, 10);
    expect(runs.map((r) => r.run_id)).toEqual(['r3', 'r2', 'r1']);
  });

  it('getRunWithItems composes run + ordered items', () => {
    createRun(db, { run_id: 'r1', session_id: sessionId, mode: 'auto', started_at: '2026' });
    upsertItem(db, { run_id: 'r1', task_id: 'tsk_b', wave_idx: 2, kind: 'verify', title: 'B', status: 'done', started_at: '2026-01-01T00:05:00Z' });
    upsertItem(db, { run_id: 'r1', task_id: 'tsk_a', wave_idx: 1, kind: 'implement', title: 'A', status: 'done', started_at: '2026-01-01T00:01:00Z' });
    const got = getRunWithItems(db, 'r1');
    expect(got?.run.run_id).toBe('r1');
    // ordering: wave_idx ASC, then started_at ASC
    expect(got?.items.map((i) => i.task_id)).toEqual(['tsk_a', 'tsk_b']);
  });

  it('getRunWithItems returns null for unknown run', () => {
    expect(getRunWithItems(db, 'nonexistent')).toBeNull();
  });
});

describe('recoverRunningRuns (boot-time recovery)', () => {
  it('promotes running run + running items to aborted/interrupted', () => {
    createRun(db, { run_id: 'r1', session_id: sessionId, mode: 'auto', started_at: '2026' });
    upsertItem(db, { run_id: 'r1', task_id: 'tsk_a', wave_idx: 1, kind: 'implement', title: 'A', status: 'running', started_at: '2026' });
    upsertItem(db, { run_id: 'r1', task_id: 'tsk_b', wave_idx: 1, kind: 'implement', title: 'B', status: 'done', started_at: '2026' });

    const promoted = recoverRunningRuns(db);
    expect(promoted).toBe(1);

    const run = getRun(db, 'r1');
    expect(run?.status).toBe('aborted');
    expect(run?.reject_reason).toBe('worker_restart');
    expect(run?.finished_at).not.toBeNull();

    const items = listItems(db, 'r1');
    const byId = new Map(items.map((i) => [i.task_id, i] as const));
    expect(byId.get('tsk_a')?.status).toBe('interrupted'); // was running → swept
    expect(byId.get('tsk_b')?.status).toBe('done');        // was done → untouched
  });

  it('is a no-op when nothing is running', () => {
    createRun(db, { run_id: 'r1', session_id: sessionId, mode: 'auto', started_at: '2026' });
    updateRun(db, 'r1', { status: 'completed' });
    expect(recoverRunningRuns(db)).toBe(0);
  });

  it('only touches runs in status=running (idempotent re-run)', () => {
    createRun(db, { run_id: 'r1', session_id: sessionId, mode: 'auto', started_at: '2026' });
    expect(recoverRunningRuns(db)).toBe(1);
    expect(recoverRunningRuns(db)).toBe(0); // already aborted; second call sweeps 0
  });
});
