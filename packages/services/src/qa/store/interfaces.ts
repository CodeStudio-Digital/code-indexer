/**
 * Storage ports for the QA subsystem. Routes and services depend on
 * these interfaces, never on the concrete `QaTestRunStore` /
 * `QaTestResultStore`. Honours Dependency Inversion: the upper layers
 * stay persistence-agnostic and can be unit-tested with in-memory fakes.
 *
 * Pure type module — both interfaces describe the minimum surface used
 * by callers; new methods land here only when a use case demands them.
 */
import type {
  QaRun,
  QaRunCompletion,
  QaRunInsert,
  QaTestResult,
  QaTestResultInsert,
} from '../types.js';

/**
 * Per-run lifecycle. The shape mirrors the lifecycle of a single
 * `npx playwright test ...` invocation: `start` → optional in-flight
 * reads → `complete` (or `abort`).
 */
export interface IQaTestRunStore {
  /**
   * Persist a new `running` row and return it. The reporter starts here.
   * `started_at` is set by the DB to `datetime('now')`.
   */
  startRun(input: QaRunInsert): Promise<QaRun>;

  /**
   * Patch the run on completion: status + counts + duration. Idempotent
   * — calling twice on the same id is a no-op for the second call (the
   * first frozen `completed_at` wins).
   */
  completeRun(runId: string, completion: QaRunCompletion): Promise<QaRun | null>;

  /**
   * Read a single run by id. Used by the detail modal and the abort
   * route (to gate "are you running?").
   */
  getRun(runId: string): Promise<QaRun | null>;

  /**
   * Recent runs for a session, newest first. Pagination via simple
   * offset/limit — the table is small enough that we never need cursor
   * pagination for v1. Optional `service_id` filters to one microservice.
   */
  listRuns(opts: {
    company_session_id: string;
    service_id?: string;
    limit?: number;
    offset?: number;
  }): Promise<QaRun[]>;

  /**
   * Current run for a session, if any (status='running'). Optionally
   * scoped to a microservice. At most one is live at a time per
   * (session, service) in the v1 model — when more than one exists we
   * return the most recently started.
   */
  getActiveRun(company_session_id: string, service_id?: string): Promise<QaRun | null>;

  /**
   * Boot-time cleanup: any row left in `running` after a server restart
   * is impossible to be a live Playwright run (the host process is
   * gone), so we mark them all as `aborted` and stamp `completed_at`.
   * Returns the number of rows mutated. Idempotent — a second call
   * does nothing.
   */
  recoverStaleRuns(): Promise<{ recovered: number }>;

  /**
   * v4.4: list runs that are still `running` past `maxAgeMs` AND have
   * received zero QA-result entities. These are runs whose reporter
   * never reached the dashboard — typical cause is a customised
   * `playwright.config.ts` that dropped the streaming reporter.
   * Used by the boot-scheduled watchdog to mark them `errored` with a
   * clear hint instead of leaving the UI spinner forever.
   *
   * B7: age is measured from the run's LAST PROGRESS —
   * `max(started_at, last_event_at)` — so a reporter that is still
   * streaming events keeps resetting the clock.
   */
  findStaleRunningRuns(maxAgeMs: number): Promise<QaRun[]>;

  /**
   * B7: stamp `last_event_at = now` on a still-`running` row. Called by
   * the test-event route on EVERY reporter event; no-op once the run
   * left `running` (idempotent under reporter retries).
   */
  touchLastEvent(runId: string): Promise<void>;

  /**
   * B7: every run currently in `running`, across ALL sessions. Used by
   * the ChromeService lifecycle hook to fail runs fast when the shared
   * browser container goes down (`error_class='sidecar_down'`).
   */
  listRunningRuns(): Promise<QaRun[]>;

  /**
   * v4.5: stamp the absolute host path where this run's artifacts were
   * copied. Lets the artifacts route fall back to disk after the
   * sandbox is destroyed. Pass `null` to clear (e.g. when the persist
   * step failed and we want the row to keep showing only sandbox
   * fallbacks).
   */
  setReportPersistedPath(runId: string, absolutePath: string | null): Promise<void>;

  /**
   * Execute an artifact write inside the owning session's writer/lease.
   * The directory is always
   * `<bundle>/company/qa-artifacts/<run UUID>` and is created with
   * symlink/junction checks before `task` runs.
   *
   * Keeping the callback behind the store prevents QA report persistence
   * from bypassing the per-session filesystem serialization boundary.
   */
  withRunArtifactDirectory<T>(
    companySessionId: string,
    runId: string,
    task: (absoluteDirectory: string) => Promise<T>,
  ): Promise<T>;

  /**
   * v4.5: count runs in the last `windowMs` that finished with the
   * watchdog's standard error message. Used by the diagnostics
   * endpoint to drive a "watchdog killed N runs in 24h" banner.
   */
  countWatchdogKills(opts: { company_session_id: string; windowMs: number }): Promise<number>;
}

/**
 * Per-test-result storage. Streamed in by the Playwright reporter as the
 * suite runs, read back by the dashboard's RunDetailModal.
 */
export interface IQaTestResultStore {
  /** Persist one test outcome. Returns the inserted row's id. */
  recordResult(input: QaTestResultInsert): Promise<string>;

  /** All results of a run, in insertion order (matches Playwright order). */
  listResults(runId: string): Promise<QaTestResult[]>;

  /** Just the failing rows of a run — convenience for bug-card composition. */
  listFailures(runId: string): Promise<QaTestResult[]>;

  /**
   * Most-recent N results for a `(spec_file, test_name)` pair. Powers
   * "is this test flaky?" badges in the history table.
   */
  recentForTest(opts: {
    spec_file: string;
    test_name: string;
    limit?: number;
  }): Promise<QaTestResult[]>;

  /**
   * v4.5 — kanban-bridge idempotency lookup. Returns the most recent
   * row for a `(spec_file, test_name)` that already has a
   * `kanban_card_id` set; used to reuse the existing bug card instead
   * of minting duplicates when the same test fails again.
   */
  findRecentResultByName(opts: {
    spec_file: string;
    test_name: string;
  }): Promise<QaTestResult | null>;

  /**
   * v4.5 — stamp the auto-created Kanban bug card id on a result row.
   * Pass `null` to clear.
   */
  setKanbanCardId(resultId: string, cardId: string | null): Promise<void>;
}
