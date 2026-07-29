import { describe, expect, it, vi } from 'vitest';
import type { IQaTestRunStore } from '@mcp/services/qa/store/interfaces.js';
import type { QaRun, QaRunCompletion } from '@mcp/services/qa/types.js';
import {
  QA_WATCHDOG_ERROR_MESSAGE,
  runWatchdogTick,
  startQaWatchdog,
} from '@mcp/services/qa/watchdog.js';

const COMPANY_SESSION_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ONE = '22222222-2222-4222-8222-222222222222';
const RUN_TWO = '33333333-3333-4333-8333-333333333333';

function qaRun(id: string, seq: number): QaRun {
  return {
    id,
    seq,
    company_session_id: COMPANY_SESSION_ID,
    agent_run_id: null,
    suite: `suite-${seq}`,
    service_id: 'main',
    status: 'running',
    started_at: '2026-07-27T12:00:00.000Z',
    completed_at: null,
    passed: 0,
    failed: 0,
    skipped: 0,
    duration_ms: null,
    trigger: 'agent',
    report_persisted_path: null,
    kanban_feature_card_id: null,
    last_error: null,
    error_class: null,
    last_event_at: null,
    plan_gate: null,
  };
}

function fakeStore(stale: QaRun[]): {
  store: IQaTestRunStore;
  findStaleRunningRuns: ReturnType<typeof vi.fn>;
  completeRun: ReturnType<typeof vi.fn>;
} {
  const findStaleRunningRuns = vi.fn(async () => stale);
  const completeRun = vi.fn(async (runId: string, completion: QaRunCompletion) => {
    const run = stale.find((candidate) => candidate.id === runId);
    return run ? { ...run, ...completion, completed_at: '2026-07-27T12:10:00.000Z' } : null;
  });
  return {
    store: { findStaleRunningRuns, completeRun } as unknown as IQaTestRunStore,
    findStaleRunningRuns,
    completeRun,
  };
}

describe('runWatchdogTick', () => {
  it('awaits filesystem-backed stale discovery and terminates every orphan by UUID', async () => {
    const first = qaRun(RUN_ONE, 1);
    const second = qaRun(RUN_TWO, 2);
    const h = fakeStore([first, second]);

    await expect(runWatchdogTick(h.store, 60_000)).resolves.toBe(2);
    expect(h.findStaleRunningRuns).toHaveBeenCalledWith(60_000);
    expect(h.completeRun).toHaveBeenNthCalledWith(1, RUN_ONE, {
      status: 'error',
      passed: 0,
      failed: 0,
      skipped: 0,
      duration_ms: null,
      last_error: QA_WATCHDOG_ERROR_MESSAGE,
      error_class: 'orphan',
    });
    expect(h.completeRun).toHaveBeenNthCalledWith(2, RUN_TWO, expect.objectContaining({
      status: 'error',
      error_class: 'orphan',
    }));
  });

  it('isolates a failed bundle mutation and continues the sweep', async () => {
    const first = qaRun(RUN_ONE, 1);
    const second = qaRun(RUN_TWO, 2);
    const h = fakeStore([first, second]);
    h.completeRun
      .mockRejectedValueOnce(new Error('writer lease lost'))
      .mockResolvedValueOnce({
        ...second,
        status: 'error',
        completed_at: '2026-07-27T12:10:00.000Z',
      });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(runWatchdogTick(h.store, 0)).resolves.toBe(1);
    expect(h.completeRun).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('writer lease lost'));
    warn.mockRestore();
  });

  it('is idempotent when the store no longer returns terminal runs', async () => {
    const h = fakeStore([qaRun(RUN_ONE, 1)]);
    expect(await runWatchdogTick(h.store, 0)).toBe(1);
    h.findStaleRunningRuns.mockResolvedValueOnce([]);
    expect(await runWatchdogTick(h.store, 0)).toBe(0);
    expect(h.completeRun).toHaveBeenCalledTimes(1);
  });
});

describe('startQaWatchdog', () => {
  it('returns an idempotent cancel function without blocking process exit', () => {
    const h = fakeStore([]);
    const cancel = startQaWatchdog(h.store, { intervalMs: 999_999, maxRunAgeMs: 0 });
    expect(cancel).toBeTypeOf('function');
    cancel();
    cancel();
  });
});

describe('QA_WATCHDOG_ERROR_MESSAGE', () => {
  it('keeps the reporter and qa_start_run remediation hint', () => {
    expect(QA_WATCHDOG_ERROR_MESSAGE).toContain('reporter.ts');
    expect(QA_WATCHDOG_ERROR_MESSAGE).toContain('qa_start_run');
  });
});
