/**
 * v4.5 — `GET /api/company/sessions/:id/qa/diagnostics`.
 *
 * Powers the diagnostic panel on Tab Testes when the run feed is empty.
 * Instead of showing a mute "No QA run in flight", the dashboard fetches
 * this endpoint to render an actionable picture:
 *
 *   - last_run                 — most recent row with `last_error` so the
 *                                UI can detect the watchdog message
 *                                (`QA_WATCHDOG_ERROR_MESSAGE`).
 *   - watchdog_kills_24h       — count of orphan-runs killed by the
 *                                watchdog in the last 24h.
 *   - reporter_drift           — `validatePlaywrightConfig` outcome plus
 *                                whether the bundled reporter and
 *                                global-setup match the templates byte
 *                                for byte.
 *   - endpoint_state           — what URL the reporter would target if
 *                                a run started right now, plus a flag
 *                                telling the UI when the host is on the
 *                                container-runtime fallback (no
 *                                MCP_PUBLIC_URL set).
 *
 * The endpoint is safe to call cheaply — no SSE, no orchestrator lookup
 * (so it works for evicted sessions). It doesn't write anything.
 */
import type { Hono } from 'hono';
import { createHash } from 'node:crypto';
import type { ServerDeps } from '../../../deps.js';
import { parseSessionIdParam } from '../../_helpers.js';
import { getSandboxManager, getResolvedRuntime } from '@mcp/services/sandbox/index.js';
import {
  validatePlaywrightConfig,
  QA_GLOBAL_SETUP_TEMPLATE,
} from '@mcp/services/sandbox/scaffolders/playwright-bootstrap.js';
import { REPORTER_TEMPLATE } from '@mcp/services/qa/playwright-reporter/reporter-template.js';
import {
  resolveEndpointBase,
  buildEndpointPath,
} from '@mcp/company/tools/qa/qa-start-run.js';

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

interface ReporterDrift {
  reporter_template_match: boolean;
  global_setup_match: boolean;
  config_missing: string[];
  config_recommendations: string[];
  /** True when the sandbox simply doesn't have the file yet (fresh session). */
  config_present: boolean;
  /** True when no sandbox exists at all — operator hasn't provisioned. */
  no_sandbox: boolean;
}

interface EndpointState {
  base: string;
  full_endpoint: string;
  fallback: boolean;
  mcp_public_url_set: boolean;
}

interface DiagnosticsResponse {
  last_run: Awaited<
    ReturnType<ServerDeps['qaTestRunStore']['listRuns']>
  >[number] | null;
  watchdog_kills_24h: number;
  reporter_drift: ReporterDrift;
  endpoint_state: EndpointState;
}

const REPORTER_TEMPLATE_HASH = sha256(REPORTER_TEMPLATE);
const GLOBAL_SETUP_HASH = sha256(QA_GLOBAL_SETUP_TEMPLATE);

export function mountQaDiagnosticsRoute(app: Hono, deps: ServerDeps): void {
  app.get('/api/company/sessions/:id/qa/diagnostics', async (c) => {
    const sessionId = parseSessionIdParam(c);
    const runs = await deps.qaTestRunStore.listRuns({
      company_session_id: sessionId,
      limit: 1,
    });
    const last_run = runs[0] ?? null;
    const watchdog_kills_24h = await deps.qaTestRunStore.countWatchdogKills({
      company_session_id: sessionId,
      windowMs: DEFAULT_WINDOW_MS,
    });

    const reporter_drift = await readReporterDrift(sessionId);
    const endpoint_state = computeEndpointState(sessionId);

    const body: DiagnosticsResponse = {
      last_run,
      watchdog_kills_24h,
      reporter_drift,
      endpoint_state,
    };
    return c.json(body);
  });
}

async function readReporterDrift(sessionId: string): Promise<ReporterDrift> {
  const out: ReporterDrift = {
    reporter_template_match: false,
    global_setup_match: false,
    config_missing: [],
    config_recommendations: [],
    config_present: false,
    no_sandbox: false,
  };
  const manager = getSandboxManager();
  const sessionKey = String(sessionId);

  // Reporter template
  let reporter: string | null = null;
  try {
    reporter = await manager.readWorkspaceFile(sessionKey, 'tests/e2e/reporter.ts');
  } catch (e) {
    if (/no sandbox/i.test(asMsg(e))) out.no_sandbox = true;
  }
  if (reporter) {
    out.reporter_template_match = sha256(reporter) === REPORTER_TEMPLATE_HASH;
  }

  // Global setup
  try {
    const globalSetup = await manager.readWorkspaceFile(sessionKey, 'tests/e2e/global-setup.ts');
    if (globalSetup) {
      out.global_setup_match = sha256(globalSetup) === GLOBAL_SETUP_HASH;
    }
  } catch {
    // already counted via no_sandbox above; ignore here
  }

  // Playwright config
  try {
    const cfg = await manager.readWorkspaceFile(sessionKey, 'playwright.config.ts');
    if (cfg) {
      out.config_present = true;
      const v = validatePlaywrightConfig(cfg);
      out.config_missing = v.missing;
      out.config_recommendations = v.recommendations;
    }
  } catch {
    // again, no_sandbox already captured
  }

  return out;
}

function computeEndpointState(sessionId: string): EndpointState {
  const { base, fallback } = resolveEndpointBase(process.env, getResolvedRuntime());
  return {
    base,
    full_endpoint: `${base}${buildEndpointPath(sessionId)}`,
    fallback,
    mcp_public_url_set: Boolean(process.env.MCP_PUBLIC_URL || process.env.MCP_DASHBOARD_URL),
  };
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function asMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
