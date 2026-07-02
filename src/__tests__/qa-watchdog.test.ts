import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import { QaTestRunStore } from '@mcp/services/qa/store/qa-test-run-store.js';
import { QaTestResultStore } from '@mcp/services/qa/store/qa-test-result-store.js';
import { runWatchdogTick, startQaWatchdog, QA_WATCHDOG_ERROR_MESSAGE } from '@mcp/services/qa/watchdog.js';

let tmp: string;
let db: CodeIndexDB;
let runStore: QaTestRunStore;
let resultStore: QaTestResultStore;

function seedSession(id: number): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db as any).db
    .prepare(
      `INSERT INTO company_sessions (id, name, status, config_json) VALUES (?, ?, 'idle', '{}')`,
    )
    .run(id, `s${id}`);
}

/** B7 — rewind started_at so age-based assertions don't need real sleeps. */
function backdateStartedAt(runId: number, minutes: number): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db as any).db
    .prepare(`UPDATE qa_test_runs SET started_at = datetime('now', ?) WHERE id = ?`)
    .run(`-${minutes} minutes`, runId);
}

/** B7 — rewind last_event_at (simulates a reporter that went silent). */
function backdateLastEventAt(runId: number, minutes: number): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db as any).db
    .prepare(`UPDATE qa_test_runs SET last_event_at = datetime('now', ?) WHERE id = ?`)
    .run(`-${minutes} minutes`, runId);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'qa-watchdog-'));
  db = new CodeIndexDB(join(tmp, 'idx.db'));
  runStore = new QaTestRunStore(db.raw());
  resultStore = new QaTestResultStore(db.raw());
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('findStaleRunningRuns', () => {
  it('returns running rows older than maxAgeMs that have zero results', () => {
    seedSession(1);
    runStore.startRun({
      company_session_id: 1,
      agent_run_id: null,
      suite: 'login',
      trigger: 'agent',
      service_id: 'main',
    });
    // maxAgeMs=0 → any row in `running` qualifies (no time pressure).
    const stale = runStore.findStaleRunningRuns(0);
    expect(stale).toHaveLength(1);
    expect(stale[0].suite).toBe('login');
  });

  it('excludes runs that already have results (reporter is alive)', () => {
    seedSession(2);
    const run = runStore.startRun({
      company_session_id: 2,
      agent_run_id: null,
      suite: 'login',
      trigger: 'agent',
      service_id: 'main',
    });
    resultStore.recordResult({
      run_id: run.id,
      spec_file: 'tests/e2e/login.spec.ts',
      test_name: 'login > valid',
      status: 'passed',
      duration_ms: 100,
      error: null,
      trace_path: null,
      screenshot_path: null,
      video_path: null,
    });
    expect(runStore.findStaleRunningRuns(0)).toHaveLength(0);
  });

  it('excludes runs that are no longer running', () => {
    seedSession(3);
    const r = runStore.startRun({
      company_session_id: 3,
      agent_run_id: null,
      suite: 'a',
      trigger: 'agent',
      service_id: 'main',
    });
    runStore.completeRun(r.id, {
      status: 'completed',
      passed: 1,
      failed: 0,
      skipped: 0,
      duration_ms: 1000,
    });
    expect(runStore.findStaleRunningRuns(0)).toHaveLength(0);
  });

  it('respects the age window when maxAgeMs > 0', () => {
    seedSession(4);
    runStore.startRun({
      company_session_id: 4,
      agent_run_id: null,
      suite: 'fresh',
      trigger: 'agent',
      service_id: 'main',
    });
    // Just-started row should NOT be considered stale at 60 s.
    expect(runStore.findStaleRunningRuns(60_000)).toHaveLength(0);
  });

  // ─── B7: adaptive age — progress via last_event_at resets the clock ──

  it('B7: an old run with recent reporter progress (last_event_at) is NOT stale', () => {
    seedSession(9);
    const run = runStore.startRun({
      company_session_id: 9,
      agent_run_id: null,
      suite: 'slow-suite',
      trigger: 'agent',
      service_id: 'main',
    });
    backdateStartedAt(run.id, 20); // started 20 min ago
    // Without progress: stale at the 10-min threshold.
    expect(runStore.findStaleRunningRuns(10 * 60_000)).toHaveLength(1);
    // Reporter event arrives → clock resets, run is healthy again.
    runStore.touchLastEvent(run.id);
    expect(runStore.findStaleRunningRuns(10 * 60_000)).toHaveLength(0);
  });

  it('B7: stale progress (old last_event_at) does not shield the run', () => {
    seedSession(10);
    const run = runStore.startRun({
      company_session_id: 10,
      agent_run_id: null,
      suite: 'silent',
      trigger: 'agent',
      service_id: 'main',
    });
    backdateStartedAt(run.id, 30);
    runStore.touchLastEvent(run.id);
    backdateLastEventAt(run.id, 15); // last progress 15 min ago
    expect(runStore.findStaleRunningRuns(10 * 60_000)).toHaveLength(1);
  });

  it('B7: touchLastEvent is a no-op once the run left running', () => {
    seedSession(11);
    const run = runStore.startRun({
      company_session_id: 11,
      agent_run_id: null,
      suite: 'done',
      trigger: 'agent',
      service_id: 'main',
    });
    runStore.completeRun(run.id, {
      status: 'completed', passed: 1, failed: 0, skipped: 0, duration_ms: 10,
    });
    runStore.touchLastEvent(run.id);
    expect(runStore.getRun(run.id)?.last_event_at).toBeNull();
  });
});

describe('runWatchdogTick', () => {
  it('marks orphan runs as errored', () => {
    seedSession(5);
    const r1 = runStore.startRun({
      company_session_id: 5,
      agent_run_id: null,
      suite: 'a',
      trigger: 'agent',
      service_id: 'main',
    });
    const r2 = runStore.startRun({
      company_session_id: 5,
      agent_run_id: null,
      suite: 'b',
      trigger: 'agent',
      service_id: 'main',
    });
    const killed = runWatchdogTick(runStore, 0);
    expect(killed).toBe(2);
    expect(runStore.getRun(r1.id)?.status).toBe('error');
    expect(runStore.getRun(r2.id)?.status).toBe('error');
    // B7 — machine-readable class (migration 189) alongside the legacy message.
    expect(runStore.getRun(r1.id)?.error_class).toBe('orphan');
    expect(runStore.getRun(r1.id)?.last_error).toBe(QA_WATCHDOG_ERROR_MESSAGE);
  });

  it('skips healthy runs (with results)', () => {
    seedSession(6);
    const r = runStore.startRun({
      company_session_id: 6,
      agent_run_id: null,
      suite: 'a',
      trigger: 'agent',
      service_id: 'main',
    });
    resultStore.recordResult({
      run_id: r.id,
      spec_file: 'a.spec.ts',
      test_name: 'a > x',
      status: 'passed',
      duration_ms: 1,
      error: null,
      trace_path: null,
      screenshot_path: null,
      video_path: null,
    });
    expect(runWatchdogTick(runStore, 0)).toBe(0);
    expect(runStore.getRun(r.id)?.status).toBe('running');
  });

  it('is idempotent — second call does nothing', () => {
    seedSession(7);
    runStore.startRun({
      company_session_id: 7,
      agent_run_id: null,
      suite: 'a',
      trigger: 'agent',
      service_id: 'main',
    });
    expect(runWatchdogTick(runStore, 0)).toBe(1);
    expect(runWatchdogTick(runStore, 0)).toBe(0);
  });
});

describe('startQaWatchdog', () => {
  it('returns a cancel function and never blocks process exit', () => {
    seedSession(8);
    runStore.startRun({
      company_session_id: 8,
      agent_run_id: null,
      suite: 'a',
      trigger: 'agent',
      service_id: 'main',
    });
    const cancel = startQaWatchdog(runStore, { intervalMs: 999_999, maxRunAgeMs: 0 });
    expect(typeof cancel).toBe('function');
    cancel();
    cancel(); // idempotent
  });
});

describe('QA_WATCHDOG_ERROR_MESSAGE', () => {
  it('mentions both the reporter file and qa_start_run', () => {
    expect(QA_WATCHDOG_ERROR_MESSAGE).toContain('reporter.ts');
    expect(QA_WATCHDOG_ERROR_MESSAGE).toContain('qa_start_run');
  });
});
