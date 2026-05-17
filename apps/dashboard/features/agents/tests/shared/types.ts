/**
 * Frontend-side type barrel for the QA Tab. Re-exports the shared
 * shapes from `core/qa/types` so the dashboard imports a single
 * surface (`./shared/types`) and never reaches into core directly —
 * keeps refactors localised.
 */
export type {
  QaRun,
  QaRunStatus,
  QaTestResult,
  QaTestStatus,
  QaRunTrigger,
  QaTestPlanScenario,
  QaTestPlanSection,
  QaRunStartedPayload,
  QaRunTestResultPayload,
  QaRunCompletedPayload,
  QaBugFiledPayload,
  QaEventName,
  QaEventMap,
  QaFailingTest,
} from '@mcp/services/qa/types.js';

/**
 * Server-side `enrichResultsWithUrls` shape (defined in
 * `apps/http-api/server/routes/company/qa/runs.ts`). Pre-computed
 * artifact URLs so the frontend doesn't reimplement encoding.
 *
 * Keep this in sync with the server type. The fields are nullable
 * because not every test produces every artifact (e.g. passed tests
 * usually have no trace/screenshot/video by default).
 */
export interface QaTestResultWithUrls {
  id: number;
  run_id: number;
  spec_file: string;
  test_name: string;
  status: import('@mcp/services/qa/types.js').QaTestStatus;
  duration_ms: number | null;
  error: string | null;
  trace_path: string | null;
  screenshot_path: string | null;
  video_path: string | null;
  /** v4.5 — workspace-relative path to the per-test markdown summary. */
  summary_md_path: string | null;
  /** v4.5 — id of the auto-created Kanban bug card (failed tests only). */
  kanban_card_id: number | null;
  created_at: string;
  trace_url: string | null;
  screenshot_url: string | null;
  video_url: string | null;
  /** v4.5 — convenience URL the dashboard renders next to each result row. */
  summary_md_url: string | null;
}

/**
 * v4.5 — payload returned by `GET /qa/diagnostics`. Used by the empty
 * state of the Live tab to surface watchdog kills, reporter drift, and
 * endpoint configuration before the operator wastes time chasing a
 * silent failure.
 */
export interface QaDiagnostics {
  last_run: import('@mcp/services/qa/types.js').QaRun | null;
  watchdog_kills_24h: number;
  reporter_drift: {
    reporter_template_match: boolean;
    global_setup_match: boolean;
    config_missing: string[];
    config_recommendations: string[];
    config_present: boolean;
    no_sandbox: boolean;
  };
  endpoint_state: {
    base: string;
    full_endpoint: string;
    fallback: boolean;
    mcp_public_url_set: boolean;
  };
}
