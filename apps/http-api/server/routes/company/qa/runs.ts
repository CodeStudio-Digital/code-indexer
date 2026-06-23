/**
 * Read endpoints for QA test runs. Pagination, detail with results, and
 * a simple abort guard. Backed by `QaTestRunStore` + `QaTestResultStore`
 * via the dep bundle — handlers stay thin.
 *
 * v4.2: every list/active/detail endpoint accepts `?service=<id>` so
 * the dashboard's microservice switcher filters per service. Detail
 * also augments each result with pre-computed artifact URLs (trace,
 * screenshot, video, full report) so the frontend doesn't duplicate
 * encoding logic.
 */
import type { Hono, Context } from 'hono';
import type { ServerDeps } from '../../../deps.js';
import { parseIdParam, parseIntQuery, notFound } from '../../_helpers.js';
import type { QaTestResult } from '@mcp/services/qa/types.js';

const DEFAULT_LIMIT = 50;
const SERVICE_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

function readServiceQuery(c: Context): string | undefined {
  const raw = c.req.query('service');
  if (!raw || raw === 'main') return undefined; // 'main' is the default; treat as unfiltered scope
  if (raw === '__all__') return undefined; // explicit "no filter" in case future UI wants it
  if (!SERVICE_ID_RE.test(raw) && raw !== 'main') {
    throw new Error('invalid service_id');
  }
  return raw;
}

function buildArtifactUrl(sessionId: number, serviceId: string, path: string): string {
  const sp = new URLSearchParams();
  sp.set('service', serviceId);
  sp.set('path', path);
  return `/api/company/sessions/${sessionId}/qa/artifact?${sp.toString()}`;
}

function buildReportUrl(sessionId: number, serviceId: string, file = 'index.html'): string {
  const sp = new URLSearchParams();
  sp.set('service', serviceId);
  sp.set('file', file);
  return `/api/company/sessions/${sessionId}/qa/playwright-report?${sp.toString()}`;
}

/** Pure: enrich each test result with absolute URLs the frontend can render. */
export function enrichResultsWithUrls(
  results: QaTestResult[],
  sessionId: number,
  serviceId: string,
): Array<QaTestResult & {
  trace_url: string | null;
  screenshot_url: string | null;
  video_url: string | null;
  summary_md_url: string | null;
}> {
  return results.map((r) => ({
    ...r,
    trace_url: r.trace_path ? buildArtifactUrl(sessionId, serviceId, r.trace_path) : null,
    screenshot_url: r.screenshot_path
      ? buildArtifactUrl(sessionId, serviceId, r.screenshot_path)
      : null,
    video_url: r.video_path ? buildArtifactUrl(sessionId, serviceId, r.video_path) : null,
    summary_md_url: r.summary_md_path
      ? buildArtifactUrl(sessionId, serviceId, r.summary_md_path)
      : null,
  }));
}

export function mountQaRunRoutes(app: Hono, deps: ServerDeps): void {
  const { qaTestRunStore, qaTestResultStore } = deps;

  app.get('/api/company/sessions/:id/qa/runs', (c) => {
    const sessionId = parseIdParam(c);
    const limit = parseIntQuery(c, 'limit', DEFAULT_LIMIT);
    const offset = parseIntQuery(c, 'offset', 0);
    let service_id: string | undefined;
    try {
      service_id = readServiceQuery(c);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    const runs = qaTestRunStore.listRuns({
      company_session_id: sessionId,
      service_id,
      limit,
      offset,
    });
    return c.json({ runs });
  });

  app.get('/api/company/sessions/:id/qa/runs/active', (c) => {
    const sessionId = parseIdParam(c);
    let service_id: string | undefined;
    try {
      service_id = readServiceQuery(c);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    const run = qaTestRunStore.getActiveRun(sessionId, service_id);
    if (!run) return c.json({ run: null });
    const rawResults = qaTestResultStore.listResults(run.id);
    const results = enrichResultsWithUrls(rawResults, sessionId, run.service_id);
    return c.json({ run, results });
  });

  app.get('/api/company/sessions/:id/qa/runs/:runId', (c) => {
    const runId = parseIdParam(c, 'runId');
    const run = qaTestRunStore.getRun(runId);
    if (!run) return notFound(c, `qa_test_run ${runId} not found`);
    // Defence: don't leak runs from other sessions.
    const sessionId = parseIdParam(c);
    if (run.company_session_id !== sessionId) return notFound(c, 'wrong session');
    const rawResults = qaTestResultStore.listResults(runId);
    const results = enrichResultsWithUrls(rawResults, sessionId, run.service_id);
    const report_url = buildReportUrl(sessionId, run.service_id);
    return c.json({ run, results, report_url });
  });

  // Abort is a soft signal in the v1 cut: we mark the row as aborted so
  // the UI stops showing the spinner; the actual playwright process is
  // expected to be terminated by the QA agent via run_command. Phase 2D
  // wires this to the orchestrator's runner.abort() once the QA agent's
  // shell handle is reachable from here.
  app.post('/api/company/sessions/:id/qa/runs/:runId/abort', (c) => {
    const runId = parseIdParam(c, 'runId');
    const run = qaTestRunStore.getRun(runId);
    if (!run) return notFound(c, `qa_test_run ${runId} not found`);
    if (run.status !== 'running') return c.json({ run });
    const updated = qaTestRunStore.completeRun(runId, {
      status: 'aborted',
      passed: run.passed,
      failed: run.failed,
      skipped: run.skipped,
      duration_ms: run.duration_ms,
    });
    return c.json({ run: updated });
  });
}
