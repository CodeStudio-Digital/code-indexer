/**
 * v4.4 — Background watchdog for orphan QA test runs.
 *
 * Symptom we're closing the door on: in session 68 the agent created a
 * QA-run entity, ran the suite, but the streaming reporter never
 * POST'd any events back. The row stayed `running` indefinitely until
 * the next server restart's `recoverStaleRuns` swept it. Operator saw
 * a permanent spinner on the dashboard.
 *
 * Loop:
 *   1. Every `intervalMs`, query `findStaleRunningRuns(maxRunAgeMs)` —
 *      runs in `running` with >maxRunAgeMs WITHOUT PROGRESS (B7: age is
 *      `max(started_at, last_event_at)`, so reporter events reset the
 *      clock) AND with zero results rows.
 *   2. Mark each as `errored` via `completeRun`, with a clear `last_error`
 *      message the dashboard can surface + `error_class='orphan'` for
 *      machine-readable filtering (B7).
 *
 * Best-effort: errors are logged, never thrown. The runtime is
 * `setInterval` with `.unref()` so it doesn't keep the process alive.
 *
 * Decoupled from boot startup so it can be unit-tested with synthetic
 * intervals — `startQaWatchdog` returns a cancel handle.
 */
import type { IQaTestRunStore } from './store/interfaces.js';

export interface QaWatchdogOptions {
  /** Poll cadence. Default 60 s — the symptom doesn't need sub-minute reaction. */
  intervalMs?: number;
  /**
   * Minimum age of a `running` row (without results) before we consider
   * it orphaned. Default 10 min. Long enough that legitimate slow specs
   * (heavy app boot, lots of fixtures) finish first; short enough that
   * the operator doesn't watch a dead row spin forever.
   */
  maxRunAgeMs?: number;
  /** Optional clock injection for tests. */
  now?: () => number;
}

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_MAX_AGE_MS = 10 * 60_000;

/**
 * Standard `last_error` message attached to runs the watchdog kills.
 * Kept stable so the frontend can match-and-render a custom hint
 * (Tab Testes can detect this string and link to the skill doc).
 */
export const QA_WATCHDOG_ERROR_MESSAGE =
  'No events received from reporter — check tests/e2e/reporter.ts wiring or run qa_start_run + the canonical command (--reporter must NOT be set on the CLI).';

/**
 * Run a single sweep. Pure-ish (effects only on the store). Returns
 * the number of runs marked errored so callers can log + tests can
 * assert. Exported for unit tests.
 */
export async function runWatchdogTick(
  runStore: IQaTestRunStore,
  maxRunAgeMs: number,
): Promise<number> {
  const stale = await runStore.findStaleRunningRuns(maxRunAgeMs);
  let killed = 0;
  for (const run of stale) {
    try {
      const updated = await runStore.completeRun(run.id, {
        status: 'error',
        passed: run.passed,
        failed: run.failed,
        skipped: run.skipped,
        duration_ms: run.duration_ms,
        // Keep the legacy message (UI + countWatchdogKills match on it)
        // and add the machine-readable class introduced by migration 189.
        last_error: run.executor === 'preview'
          ? 'Preview QA did not finish its acceptance checks. Inspect the original preview operation, then start a new run after reconciliation.'
          : QA_WATCHDOG_ERROR_MESSAGE,
        error_class: 'orphan',
      });
      if (updated && updated.status === 'error') killed++;
    } catch (e) {
      console.warn(
        `[qa-watchdog] mark run ${run.id} errored failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return killed;
}

/**
 * Start the periodic watchdog. Returns a cancel function. Idempotent —
 * call cancel multiple times safely. The interval is `.unref()`'d so a
 * stuck watchdog never blocks process exit.
 */
export function startQaWatchdog(
  runStore: IQaTestRunStore,
  opts: QaWatchdogOptions = {},
): () => void {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxRunAgeMs = opts.maxRunAgeMs ?? DEFAULT_MAX_AGE_MS;

  const tick = async (): Promise<void> => {
    try {
      const killed = await runWatchdogTick(runStore, maxRunAgeMs);
      if (killed > 0) {
        console.log(
          `[qa-watchdog] Marked ${killed} orphan QA run(s) errored (no reporter events received in ${Math.round(maxRunAgeMs / 1000)}s).`,
        );
      }
    } catch (e) {
      console.warn(
        `[qa-watchdog] tick failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

  const handle = setInterval(() => {
    void tick();
  }, intervalMs);
  if (typeof handle.unref === 'function') handle.unref();
  let cancelled = false;
  return () => {
    if (cancelled) return;
    cancelled = true;
    clearInterval(handle);
  };
}
