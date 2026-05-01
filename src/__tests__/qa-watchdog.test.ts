import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '../store/db.js';
import { QaTestRunStore } from '../core/qa/store/qa-test-run-store.js';
import { QaTestResultStore } from '../core/qa/store/qa-test-result-store.js';
import { runWatchdogTick, startQaWatchdog, QA_WATCHDOG_ERROR_MESSAGE } from '../core/qa/watchdog.js';

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
