/**
 * Shared type module for the QA subsystem.
 *
 * **Single source of truth** for both frontend (TestsTab UI) and backend
 * (stores, routes, reporters). Importing from a single module means a
 * type change ripples through TypeScript on both sides immediately —
 * the dashboard cannot drift from the schema and vice versa.
 *
 * Pure type-only module — nothing executable, no dependencies on either
 * `better-sqlite3` or React, so it's free to import from any layer.
 */

// ─── Run status ─────────────────────────────────────────────────

/** Lifecycle of a single Playwright run, persisted in `qa_test_runs.status`. */
export type QaRunStatus = 'running' | 'completed' | 'aborted' | 'error';

/** Per-test verdict, persisted in `qa_test_results.status`. Mirrors Playwright's reporter. */
export type QaTestStatus =
  | 'passed'
  | 'failed'
  | 'skipped'
  | 'timed-out'
  | 'interrupted';

/** Who/what kicked off the run. Trailing into UI filters and bug-card metadata. */
export type QaRunTrigger = 'agent' | 'human' | 'watcher';

// ─── Persistence rows ───────────────────────────────────────────

/**
 * A single Playwright invocation. One row per `npx playwright test ...`
 * the QA agent runs. Transitions: `running → completed | aborted | error`.
 */
export interface QaRun {
  id: number;
  company_session_id: number;
  agent_run_id: number | null;
  /** Suite identifier — typically the spec file or feature name. */
  suite: string;
  /**
   * Microservice id this run targets — `'main'` (default) for the
   * primary container, or the `service_id` of an additional service
   * when the agent runs the suite from a sibling workspace. The
   * dashboard's Tab Testes filters by this so the operator can audit
   * QA per service.
   */
  service_id: string;
  status: QaRunStatus;
  started_at: string;
  completed_at: string | null;
  passed: number;
  failed: number;
  skipped: number;
  duration_ms: number | null;
  trigger: QaRunTrigger;
  /**
   * Absolute host filesystem path where the run's `playwright-report/`
   * + `test-results/` were copied to after the suite completed. Set by
   * the report-persistence helper on `qa_run_completed`. When non-null,
   * the artifacts route serves from disk, not the sandbox — so the
   * evidence survives sandbox destruction. Null while the run is in
   * flight or if persistence failed.
   */
  report_persisted_path: string | null;
  /**
   * Optional id of the "QA: <feature>" Kanban card this run is auditing.
   * Set by `qa_start_run` when the agent passes `kanban_feature_card_id`.
   * The kanban-bridge auto-moves this card between `in_progress` (on
   * red runs) and `done` (on green runs) based on the run's outcome.
   */
  kanban_feature_card_id: number | null;
  /**
   * When the run terminates without a clean `completed`, the reason
   * lands here. Today's only writer is the watchdog (`runWatchdogTick`),
   * which stamps `QA_WATCHDOG_ERROR_MESSAGE` so the dashboard can
   * detect "no events received from reporter" and render an actionable
   * banner. Future writers (abort with reason, etc.) will populate the
   * same column.
   */
  last_error: string | null;
}

/**
 * One row per individual `test(...)` outcome. Streamed in by the custom
 * Playwright reporter (`tests/e2e/reporter.ts`) as the run progresses,
 * so the LiveRunView can update incrementally without waiting for the
 * suite to finish.
 */
export interface QaTestResult {
  id: number;
  run_id: number;
  spec_file: string;
  test_name: string;
  status: QaTestStatus;
  duration_ms: number | null;
  /** Error message when status is `failed` / `timed-out`. Null otherwise. */
  error: string | null;
  /** Workspace-relative path to a Playwright trace.zip when the test produced one. */
  trace_path: string | null;
  /**
   * Workspace-relative path to a Playwright screenshot for this test.
   * v4.5: bundled config now uses `screenshot:'on'` so EVERY test
   * (pass or fail) writes one. The reporter indexes the path so the
   * dashboard can render a thumbnail on each row.
   */
  screenshot_path: string | null;
  /**
   * Workspace-relative path to a Playwright video file (`video.webm`).
   * v4.5: bundled config uses `video:'on'` so every test produces one.
   */
  video_path: string | null;
  /**
   * Workspace-relative path to a per-test markdown summary
   * (`test-results/<safe-name>/summary.md`). The reporter writes this
   * for every test in `onTestEnd` — title, status, steps tree,
   * truncated stdout/stderr, attachments. Gives the operator a textual
   * trail without opening the HTML report.
   */
  summary_md_path: string | null;
  /**
   * Id of the auto-created Kanban bug card for this failure, when
   * applicable. Populated by the kanban-bridge on `qa_run_completed`
   * for results with status in (`failed`, `timed-out`, `interrupted`).
   * Null for passing/skipped tests. Idempotent — recurring failures of
   * the same `<suite>:<test>` reuse the existing card.
   */
  kanban_card_id: number | null;
  created_at: string;
}

// ─── Insert shapes ──────────────────────────────────────────────

/** Input to `QaTestRunStore.startRun` — caller supplies what it knows. */
export interface QaRunInsert {
  company_session_id: number;
  agent_run_id: number | null;
  suite: string;
  trigger: QaRunTrigger;
  /** Defaults to `'main'` when omitted. */
  service_id?: string;
  /**
   * Optional Kanban feature card id this run audits. Persisted on the
   * row so the kanban-bridge can locate the card on `completed` and
   * transition it (`in_progress` on red, `done` on green) without an
   * extra round-trip.
   */
  kanban_feature_card_id?: number | null;
}

/**
 * Patch applied to a run when the reporter emits `onEnd` or the runner
 * decides to abort. Counts default to 0 when the run errored before any
 * test reported.
 */
export interface QaRunCompletion {
  status: QaRunStatus;
  passed: number;
  failed: number;
  skipped: number;
  duration_ms: number | null;
  /**
   * Optional message stamped into `qa_test_runs.last_error`. Set by the
   * watchdog so the diagnostics endpoint can detect "no events received
   * from reporter" and surface an actionable banner. Reporter-driven
   * `completed` events leave this null.
   */
  last_error?: string | null;
}

/** Input to `QaTestResultStore.recordResult` — emitted on each `onTestEnd`. */
export interface QaTestResultInsert {
  run_id: number;
  spec_file: string;
  test_name: string;
  status: QaTestStatus;
  duration_ms: number | null;
  error: string | null;
  trace_path: string | null;
  screenshot_path?: string | null;
  video_path?: string | null;
  /**
   * Workspace-relative path to the per-test markdown summary the
   * reporter writes (`test-results/<safe-name>/summary.md`). v4.5+.
   */
  summary_md_path?: string | null;
}

// ─── Test plan ──────────────────────────────────────────────────

/**
 * Parsed structure of `tests/e2e/TEST_PLAN.md` after pulling section
 * headings + bullet items. The frontend's TestPlanView renders this to
 * cross-reference each scenario with its latest `QaTestResult`.
 *
 * Pure data — populated by `parseTestPlanSections` (a pure function).
 */
export interface QaTestPlanSection {
  /** Priority bucket label as written in the markdown (e.g. "Critical flows (P0)"). */
  heading: string;
  /** Optional priority extracted from the heading (P0/P1/P2/…). */
  priority: string | null;
  scenarios: QaTestPlanScenario[];
}

export interface QaTestPlanScenario {
  /** Bullet text without the leading "- ". */
  text: string;
  /** Spec file the scenario maps to (when an explicit table row pinned it). */
  specFile?: string;
}

// ─── Re-export stream event payloads ────────────────────────────

// The QA tool already declares the on-the-wire event payloads; re-export
// them from here so both ends import a single barrel.
export type {
  QaEventName,
  QaEventMap,
  QaFailingTest,
  QaRunStartedPayload,
  QaRunTestResultPayload,
  QaRunCompletedPayload,
  QaBugFiledPayload,
} from '@mcp/company/tools/qa/qa-event-types.js';
