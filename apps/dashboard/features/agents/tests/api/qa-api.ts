/**
 * HTTP client for QA endpoints. Components/hooks use this — never
 * `fetch` direct — so authentication headers, base URL, and retry
 * policy stay in one place.
 *
 * Pure async functions returning typed results. Errors propagate as
 * thrown `Error` with the response text; callers can catch and
 * surface in the UI.
 */
import type { QaDiagnostics, QaRun, QaTestResultWithUrls } from '../shared/types.js';

const BASE = '/api/company/sessions';

/** Recent runs for a session, newest first. Optional service filter. */
export async function fetchRuns(opts: {
  sessionId: string;
  serviceId?: string;
  limit?: number;
  offset?: number;
  signal?: AbortSignal;
}): Promise<{ runs: QaRun[] }> {
  const url = new URL(`${BASE}/${opts.sessionId}/qa/runs`, window.location.origin);
  if (opts.serviceId) url.searchParams.set('service', opts.serviceId);
  if (opts.limit !== undefined) url.searchParams.set('limit', String(opts.limit));
  if (opts.offset !== undefined) url.searchParams.set('offset', String(opts.offset));
  return getJson(url.pathname + url.search, opts.signal);
}

/** Currently active run for a session, with its inflight results. */
export async function fetchActiveRun(opts: {
  sessionId: string;
  serviceId?: string;
  signal?: AbortSignal;
}): Promise<{
  run: QaRun | null;
  results?: QaTestResultWithUrls[];
}> {
  const url = new URL(
    `${BASE}/${opts.sessionId}/qa/runs/active`,
    window.location.origin,
  );
  if (opts.serviceId) url.searchParams.set('service', opts.serviceId);
  return getJson(url.pathname + url.search, opts.signal);
}

/** Detail of a single past run (with all its result rows + report URL). */
export async function fetchRunDetail(opts: {
  sessionId: string;
  runId: string;
  signal?: AbortSignal;
}): Promise<{
  run: QaRun;
  results: QaTestResultWithUrls[];
  report_url: string;
}> {
  return getJson(`${BASE}/${opts.sessionId}/qa/runs/${opts.runId}`, opts.signal);
}

/** Pure: build the URL of an arbitrary workspace artifact (used in places that don't go through `enrichResultsWithUrls`). */
export function buildArtifactUrl(opts: {
  sessionId: string;
  serviceId?: string;
  path: string;
}): string {
  const sp = new URLSearchParams();
  sp.set('service', opts.serviceId ?? 'main');
  sp.set('path', opts.path);
  return `${BASE}/${opts.sessionId}/qa/artifact?${sp.toString()}`;
}

/** Pure: build the URL of the Playwright HTML report. */
export function buildPlaywrightReportUrl(opts: {
  sessionId: string;
  serviceId?: string;
  file?: string;
}): string {
  const sp = new URLSearchParams();
  sp.set('service', opts.serviceId ?? 'main');
  sp.set('file', opts.file ?? 'index.html');
  return `${BASE}/${opts.sessionId}/qa/playwright-report?${sp.toString()}`;
}

/** Soft-abort: marks the run as `aborted` so the UI stops showing the spinner. */
async function abortRun(opts: { sessionId: string; runId: string }): Promise<{ run: QaRun }> {
  const res = await fetch(`${BASE}/${opts.sessionId}/qa/runs/${opts.runId}/abort`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(await safeText(res));
  return res.json();
}

/**
 * v4.4 — operator-driven recovery for the MCP-managed QA workspace
 * artifacts. Mirrors what `qa_start_run` does on the agent side:
 *   - force-restores `tests/e2e/reporter.ts`
 *   - force-restores `tests/e2e/global-setup.ts`
 *   - validates `playwright.config.ts` and writes a `.recommended`
 *     sibling when drifted
 *
 * Returns the report so the UI can render ✓/⚠ feedback.
 */
export interface QaRestoreReport {
  runConfigWritten: boolean;
  reporterRestored: boolean;
  globalSetupRestored: boolean;
  configMissing: string[];
  configRecommendedWritten: boolean;
  warnings: string[];
}

export async function restoreQaConfig(opts: { sessionId: string }): Promise<{
  ok: boolean;
  report?: QaRestoreReport;
  error?: string;
  message?: string;
}> {
  const res = await fetch(`${BASE}/${opts.sessionId}/qa/restore-config`, {
    method: 'POST',
  });
  // We DON'T throw on non-2xx here — the server returns structured
  // error info (e.g. {ok:false, error:'no-sandbox'}) we want to render.
  const body = await res.json().catch(() => ({}));
  return body as { ok: boolean; report?: QaRestoreReport };
}

/**
 * v4.5 — fetch the diagnostics payload for the current session. The
 * Live empty-state uses this to render an actionable panel instead of
 * a mute "No QA run in flight".
 */
export async function fetchQaDiagnostics(opts: {
  sessionId: string;
}): Promise<QaDiagnostics> {
  return getJson(`${BASE}/${opts.sessionId}/qa/diagnostics`);
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { signal });
  if (!res.ok) throw new Error(await safeText(res));
  return res.json() as Promise<T>;
}

async function safeText(res: Response): Promise<string> {
  try {
    return `${res.status} ${res.statusText} — ${await res.text()}`;
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}
