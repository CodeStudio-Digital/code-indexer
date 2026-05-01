import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '../store/db.js';
import { QaTestRunStore } from '../core/qa/store/qa-test-run-store.js';
import { QaTestResultStore } from '../core/qa/store/qa-test-result-store.js';

/**
 * Integration tests for the QA stores. We use the real `CodeIndexDB`
 * because migration 001 is a no-op that delegates table creation to
 * `initSchema()` — running migrations standalone against an empty
 * `:memory:` would fail at migration 002 (missing `symbols` table).
 *
 * Tests use a tmpdir-backed file (matching `db.test.ts` pattern) so the
 * full schema is materialised before our QA tables are touched.
 */

function seedSession(db: CodeIndexDB, id: number, name: string): void {
  // company_sessions schema is owned by migration 018.
  // We only need a parent row so qa_test_runs.company_session_id FK is satisfied.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db as any).db
    .prepare(
      `INSERT INTO company_sessions (id, name, status, config_json) VALUES (?, ?, 'idle', '{}')`,
    )
    .run(id, name);
}

describe('QA stores (integration)', () => {
  let dir: string;
  let cdb: CodeIndexDB;
  let runs: QaTestRunStore;
  let results: QaTestResultStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-qa-stores-'));
    cdb = new CodeIndexDB(join(dir, 'test.db'));
    seedSession(cdb, 1, 'session-1');
    seedSession(cdb, 2, 'session-2');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handle = (cdb as any).db;
    runs = new QaTestRunStore(handle);
    results = new QaTestResultStore(handle);
  });

  afterEach(() => {
    cdb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('QaTestRunStore.startRun', () => {
    it('persists a running row with default counts', () => {
      const run = runs.startRun({
        company_session_id: 1,
        agent_run_id: null,
        suite: 'login',
        trigger: 'agent',
      });
      expect(run.status).toBe('running');
      expect(run.passed).toBe(0);
      expect(run.failed).toBe(0);
      expect(run.skipped).toBe(0);
      expect(run.completed_at).toBeNull();
      expect(run.suite).toBe('login');
      expect(run.trigger).toBe('agent');
    });
  });

  describe('QaTestRunStore.completeRun', () => {
    it('updates status, counts, duration and sets completed_at', () => {
      const run = runs.startRun({
        company_session_id: 1,
        agent_run_id: null,
        suite: 's',
        trigger: 'human',
      });
      const completed = runs.completeRun(run.id, {
        status: 'completed',
        passed: 4,
        failed: 1,
        skipped: 0,
        duration_ms: 1234,
      });
      expect(completed?.status).toBe('completed');
      expect(completed?.passed).toBe(4);
      expect(completed?.failed).toBe(1);
      expect(completed?.duration_ms).toBe(1234);
      expect(completed?.completed_at).not.toBeNull();
    });

    it('is idempotent — second call does not change frozen completed_at', () => {
      const run = runs.startRun({
        company_session_id: 1,
        agent_run_id: null,
        suite: 's',
        trigger: 'agent',
      });
      const first = runs.completeRun(run.id, {
        status: 'completed',
        passed: 1,
        failed: 0,
        skipped: 0,
        duration_ms: 100,
      });
      const second = runs.completeRun(run.id, {
        status: 'aborted',
        passed: 99,
        failed: 99,
        skipped: 99,
        duration_ms: 999,
      });
      expect(second?.status).toBe('completed');
      expect(second?.passed).toBe(1);
      expect(second?.completed_at).toBe(first?.completed_at);
    });

    it('returns null for unknown id', () => {
      expect(
        runs.completeRun(9999, {
          status: 'completed',
          passed: 0,
          failed: 0,
          skipped: 0,
          duration_ms: 0,
        }),
      ).toBeNull();
    });
  });

  describe('QaTestRunStore.listRuns', () => {
    it('returns newest first, limited and offset-able', () => {
      runs.startRun({ company_session_id: 1, agent_run_id: null, suite: 'a', trigger: 'agent' });
      runs.startRun({ company_session_id: 1, agent_run_id: null, suite: 'b', trigger: 'agent' });
      runs.startRun({ company_session_id: 1, agent_run_id: null, suite: 'c', trigger: 'agent' });

      const all = runs.listRuns({ company_session_id: 1 });
      expect(all.map((r) => r.suite)).toEqual(['c', 'b', 'a']);

      const page1 = runs.listRuns({ company_session_id: 1, limit: 2 });
      expect(page1.map((r) => r.suite)).toEqual(['c', 'b']);

      const page2 = runs.listRuns({ company_session_id: 1, limit: 2, offset: 2 });
      expect(page2.map((r) => r.suite)).toEqual(['a']);
    });

    it('isolates runs by session', () => {
      runs.startRun({ company_session_id: 1, agent_run_id: null, suite: 'one', trigger: 'agent' });
      runs.startRun({ company_session_id: 2, agent_run_id: null, suite: 'two', trigger: 'agent' });
      const s1 = runs.listRuns({ company_session_id: 1 });
      const s2 = runs.listRuns({ company_session_id: 2 });
      expect(s1).toHaveLength(1);
      expect(s2).toHaveLength(1);
      expect(s1[0].suite).toBe('one');
      expect(s2[0].suite).toBe('two');
    });

    it('clamps limits to MAX', () => {
      runs.startRun({ company_session_id: 1, agent_run_id: null, suite: 'a', trigger: 'agent' });
      const list = runs.listRuns({ company_session_id: 1, limit: 9_999_999 });
      expect(list).toHaveLength(1);
    });
  });

  describe('QaTestRunStore.recoverStaleRuns', () => {
    it('marks all running rows as aborted with completed_at stamped', () => {
      const a = runs.startRun({ company_session_id: 1, agent_run_id: null, suite: 'a', trigger: 'agent' });
      const b = runs.startRun({ company_session_id: 1, agent_run_id: null, suite: 'b', trigger: 'agent' });
      const c = runs.startRun({ company_session_id: 2, agent_run_id: null, suite: 'c', trigger: 'human' });
      expect(runs.getRun(a.id)?.status).toBe('running');

      const result = runs.recoverStaleRuns();
      expect(result.recovered).toBe(3);
      expect(runs.getRun(a.id)?.status).toBe('aborted');
      expect(runs.getRun(b.id)?.status).toBe('aborted');
      expect(runs.getRun(c.id)?.status).toBe('aborted');
      expect(runs.getRun(a.id)?.completed_at).not.toBeNull();
    });

    it('is idempotent — second call recovers zero', () => {
      runs.startRun({ company_session_id: 1, agent_run_id: null, suite: 's', trigger: 'agent' });
      expect(runs.recoverStaleRuns().recovered).toBe(1);
      expect(runs.recoverStaleRuns().recovered).toBe(0);
    });

    it('does not touch runs already in a terminal state', () => {
      const finished = runs.startRun({ company_session_id: 1, agent_run_id: null, suite: 'done', trigger: 'agent' });
      runs.completeRun(finished.id, { status: 'completed', passed: 1, failed: 0, skipped: 0, duration_ms: 100 });
      const finishedBefore = runs.getRun(finished.id);

      const stale = runs.startRun({ company_session_id: 1, agent_run_id: null, suite: 'stale', trigger: 'agent' });
      const result = runs.recoverStaleRuns();

      expect(result.recovered).toBe(1);
      expect(runs.getRun(stale.id)?.status).toBe('aborted');
      // Untouched: same status, same counts, same completed_at.
      expect(runs.getRun(finished.id)?.status).toBe('completed');
      expect(runs.getRun(finished.id)?.passed).toBe(1);
      expect(runs.getRun(finished.id)?.completed_at).toBe(finishedBefore?.completed_at);
    });

    it('returns 0 on a clean DB', () => {
      expect(runs.recoverStaleRuns().recovered).toBe(0);
    });
  });

  describe('QaTestRunStore.getActiveRun', () => {
    it('returns null when no run is in flight', () => {
      expect(runs.getActiveRun(1)).toBeNull();
    });

    it('returns the running row', () => {
      const r = runs.startRun({ company_session_id: 1, agent_run_id: null, suite: 's', trigger: 'agent' });
      const active = runs.getActiveRun(1);
      expect(active?.id).toBe(r.id);
    });

    it('returns null after completion', () => {
      const r = runs.startRun({ company_session_id: 1, agent_run_id: null, suite: 's', trigger: 'agent' });
      runs.completeRun(r.id, { status: 'completed', passed: 0, failed: 0, skipped: 0, duration_ms: 0 });
      expect(runs.getActiveRun(1)).toBeNull();
    });
  });

  describe('QaTestResultStore', () => {
    it('records and reads back results in insertion order', () => {
      const r = runs.startRun({ company_session_id: 1, agent_run_id: null, suite: 's', trigger: 'agent' });
      results.recordResult({
        run_id: r.id,
        spec_file: 'tests/e2e/login.spec.ts',
        test_name: 'login > valid',
        status: 'passed',
        duration_ms: 120,
        error: null,
        trace_path: null,
      });
      results.recordResult({
        run_id: r.id,
        spec_file: 'tests/e2e/login.spec.ts',
        test_name: 'login > wrong password',
        status: 'failed',
        duration_ms: 250,
        error: 'expected toast to be visible',
        trace_path: 'test-results/login-wrong-trace.zip',
      });

      const list = results.listResults(r.id);
      expect(list).toHaveLength(2);
      expect(list[0].test_name).toBe('login > valid');
      expect(list[1].status).toBe('failed');
      expect(list[1].error).toBe('expected toast to be visible');
    });

    it('listFailures filters to failed-like statuses only', () => {
      const r = runs.startRun({ company_session_id: 1, agent_run_id: null, suite: 's', trigger: 'agent' });
      results.recordResult({ run_id: r.id, spec_file: 'a.ts', test_name: 'p', status: 'passed', duration_ms: 1, error: null, trace_path: null });
      results.recordResult({ run_id: r.id, spec_file: 'a.ts', test_name: 's', status: 'skipped', duration_ms: 0, error: null, trace_path: null });
      results.recordResult({ run_id: r.id, spec_file: 'a.ts', test_name: 'f', status: 'failed', duration_ms: 1, error: 'x', trace_path: null });
      results.recordResult({ run_id: r.id, spec_file: 'a.ts', test_name: 't', status: 'timed-out', duration_ms: 30000, error: 'timeout', trace_path: null });

      const failures = results.listFailures(r.id);
      expect(failures.map((f) => f.test_name).sort()).toEqual(['f', 't']);
    });

    it('recentForTest pulls history for flake detection', () => {
      const r1 = runs.startRun({ company_session_id: 1, agent_run_id: null, suite: 's', trigger: 'agent' });
      const r2 = runs.startRun({ company_session_id: 1, agent_run_id: null, suite: 's', trigger: 'agent' });
      results.recordResult({ run_id: r1.id, spec_file: 'a.ts', test_name: 'flaky', status: 'passed', duration_ms: 1, error: null, trace_path: null });
      results.recordResult({ run_id: r2.id, spec_file: 'a.ts', test_name: 'flaky', status: 'failed', duration_ms: 1, error: 'x', trace_path: null });

      const history = results.recentForTest({ spec_file: 'a.ts', test_name: 'flaky' });
      expect(history).toHaveLength(2);
      // Newest first — r2 was inserted last so its result is most recent.
      expect(history[0].status).toBe('failed');
      expect(history[1].status).toBe('passed');
    });

    it('cascades on run delete', () => {
      const r = runs.startRun({ company_session_id: 1, agent_run_id: null, suite: 's', trigger: 'agent' });
      results.recordResult({ run_id: r.id, spec_file: 'a.ts', test_name: 'x', status: 'passed', duration_ms: 1, error: null, trace_path: null });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (cdb as any).db.prepare('DELETE FROM qa_test_runs WHERE id = ?').run(r.id);
      expect(results.listResults(r.id)).toEqual([]);
    });

    it('cascades on company session delete', () => {
      const r = runs.startRun({ company_session_id: 1, agent_run_id: null, suite: 's', trigger: 'agent' });
      results.recordResult({ run_id: r.id, spec_file: 'a.ts', test_name: 'x', status: 'passed', duration_ms: 1, error: null, trace_path: null });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (cdb as any).db.prepare('DELETE FROM company_sessions WHERE id = 1').run();
      expect(runs.listRuns({ company_session_id: 1 })).toEqual([]);
      expect(results.listResults(r.id)).toEqual([]);
    });
  });

  // ─── v4.5 fields ───────────────────────────────────────────────

  describe('v4.5 — kanban_feature_card_id + last_error + report_persisted_path', () => {
    it('startRun persists kanban_feature_card_id', () => {
      const run = runs.startRun({
        company_session_id: 1,
        agent_run_id: null,
        suite: 'login',
        trigger: 'agent',
        kanban_feature_card_id: null,
      });
      expect(run.kanban_feature_card_id).toBeNull();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handle = (cdb as any).db;
      handle
        .prepare(
          `INSERT INTO kanban_cards (id, company_session_id, title, description, "column", position) VALUES (88, 1, 'QA: login', '', 'in_progress', 0)`,
        )
        .run();
      const run2 = runs.startRun({
        company_session_id: 1,
        agent_run_id: null,
        suite: 'login',
        trigger: 'agent',
        kanban_feature_card_id: 88,
      });
      expect(run2.kanban_feature_card_id).toBe(88);
    });

    it('completeRun persists last_error and countWatchdogKills picks it up', () => {
      const run = runs.startRun({ company_session_id: 1, agent_run_id: null, suite: 's', trigger: 'agent' });
      runs.completeRun(run.id, {
        status: 'error',
        passed: 0,
        failed: 0,
        skipped: 0,
        duration_ms: null,
        last_error: 'No events received from reporter — check tests/e2e/reporter.ts wiring or run qa_start_run',
      });
      const fetched = runs.getRun(run.id);
      expect(fetched?.last_error).toContain('No events received from reporter');

      const kills = runs.countWatchdogKills({ company_session_id: 1, windowMs: 60_000 });
      expect(kills).toBe(1);
    });

    it('setReportPersistedPath round-trips through getRun', () => {
      const run = runs.startRun({ company_session_id: 1, agent_run_id: null, suite: 's', trigger: 'agent' });
      expect(run.report_persisted_path).toBeNull();
      runs.setReportPersistedPath(run.id, '/data/qa-reports/1/42');
      expect(runs.getRun(run.id)?.report_persisted_path).toBe('/data/qa-reports/1/42');
      runs.setReportPersistedPath(run.id, null);
      expect(runs.getRun(run.id)?.report_persisted_path).toBeNull();
    });

    it('result store recordResult persists summary_md_path', () => {
      const r = runs.startRun({ company_session_id: 1, agent_run_id: null, suite: 's', trigger: 'agent' });
      const id = results.recordResult({
        run_id: r.id,
        spec_file: 'a.ts',
        test_name: 'x',
        status: 'passed',
        duration_ms: 1,
        error: null,
        trace_path: null,
        summary_md_path: 'test-results/x/summary.md',
      });
      const list = results.listResults(r.id);
      expect(list[0].id).toBe(id);
      expect(list[0].summary_md_path).toBe('test-results/x/summary.md');
    });

    it('setKanbanCardId + findRecentResultByName round-trip for the kanban-bridge', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handle = (cdb as any).db;
      handle
        .prepare(
          `INSERT INTO kanban_cards (id, company_session_id, title, description, "column", position, tag) VALUES (501, 1, '[QA-BUG] s: x', '', 'todo', 0, 'bug')`,
        )
        .run();
      const r1 = runs.startRun({ company_session_id: 1, agent_run_id: null, suite: 's', trigger: 'agent' });
      const id1 = results.recordResult({
        run_id: r1.id,
        spec_file: 'a.ts',
        test_name: 'x',
        status: 'failed',
        duration_ms: 1,
        error: 'broke',
        trace_path: null,
      });
      results.setKanbanCardId(id1, 501);

      const found = results.findRecentResultByName({ spec_file: 'a.ts', test_name: 'x' });
      expect(found?.id).toBe(id1);
      expect(found?.kanban_card_id).toBe(501);
    });
  });
});
