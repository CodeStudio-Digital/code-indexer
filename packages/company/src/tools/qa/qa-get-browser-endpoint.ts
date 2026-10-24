import { fetchSidecarVersion, type SidecarVersionInfo } from './qa-sidecar-probe.js';
export { fetchSidecarVersion, type SidecarVersionInfo } from './qa-sidecar-probe.js';
import { setQaEndpointEnvStore, getQaEndpointEnvStore } from './qa-endpoint-state.js';
export { setQaEndpointEnvStore, getQaEndpointEnvStore } from './qa-endpoint-state.js';
/**
 * Tool: `qa_get_browser_endpoint`. Returns the WebSocket URL the QA
 * agent must pass to `chromium.connect({ wsEndpoint })`. The endpoint
 * lives in the SHARED Chrome Service container managed by the
 * operator via the Admin Panel; the agent never launches a browser
 * locally (the skill prompt explicitly forbids it).
 *
 * Beyond returning the URL, the tool runs a live health probe against
 * the Chrome Service's CDP `/json/version` endpoint so the agent can
 * decide whether to retry a flaky run vs. flag the operator.
 *
 * Pure helpers exported separately (`fetchSidecarVersion`,
 * `formatBrowserEndpointReply`) so unit tests can verify both the
 * health-check parser and the message formatter without spinning up
 * a real container.
 */
import type { CoderTool } from "@mcp/code-agent/core/tool.js";
import type { JsonSchema } from "@mcp/provider-sdk";
import { ok, err } from "@mcp/agent-runtime-host/tool-result.js";
import type { CompanyOrchestratorPort as CompanyOrchestrator } from '@mcp/company/orchestrator-port.js';
import { tryGetChromeService } from '@mcp/services/chrome-service/chrome-service.js';
import type { ChromeServiceState } from '@mcp/services/chrome-service/chrome-service.js';
import type { CompanySessionEnvStore } from '@mcp/store/company-session-env-store.js';
import { preflightBrowser } from './qa-preflight.js';




const PARAMETERS: JsonSchema = {
  type: 'object',
  properties: {},
};




/**
 * Pure: collect the QA preview URL family for one session out of the
 * env store. Returns `[]` when the store is unwired or the session has
 * no `PLAYWRIGHT_BASE_URL_*` rows (non-QA session). Used by
 * `formatBrowserEndpointReply` so the agent sees the URLs it must
 * navigate to alongside the wsEndpoint.
 */
export function collectPlaywrightBaseUrls(
  store: CompanySessionEnvStore | null,
  sessionId: string | null,
): Array<{ key: string; value: string }> {
  if (!store || sessionId == null) return [];
  try {
    return store
      .list(sessionId)
      .filter((row) => row.key === 'PLAYWRIGHT_BASE_URL' || row.key.startsWith('PLAYWRIGHT_BASE_URL_'))
      .map((row) => ({ key: row.key, value: row.value }))
      .sort((a, b) => a.key.localeCompare(b.key));
  } catch {
    return [];
  }
}

/**
 * Pure: render the reply body the agent reads. Format optimised for
 * LLM parsing — line-per-fact, no markdown noise, includes the env
 * var the agent should be using already.
 */
export function formatBrowserEndpointReply(
  state: ChromeServiceState | null,
  health: SidecarVersionInfo,
  previewUrls: Array<{ key: string; value: string }> = [],
): string {
  if (!state) {
    return [
      'Chrome Service is not available on this host.',
      '',
      'Diagnosis: the singleton is not wired (server bootstrap issue).',
      '',
      'Action: tell the operator to check the http-api boot logs.',
      'Do NOT try to install a browser locally.',
    ].join('\n');
  }
  if (state.status !== 'running') {
    const reason =
      state.status === 'stopped'
        ? 'disabled by the operator'
        : state.status === 'starting'
          ? 'starting up — try again in a few seconds'
          : `errored: ${state.lastError ?? 'unknown'}`;
    return [
      `Chrome Service is ${state.status} (${reason}).`,
      '',
      'Action: ask the operator to enable / restart the Chrome Service in',
      'Admin → Chrome Service. Do NOT try to install a browser locally.',
    ].join('\n');
  }
  const lines = [
    `wsEndpoint: ${state.wsEndpoint}`,
    `image:      ${state.image}`,
    `alive:      ${health.ok ? 'true' : 'false'}`,
  ];
  if (!health.ok) {
    lines.push(`error:      ${health.error ?? `HTTP ${health.status}`}`);
  }

  if (previewUrls.length > 0) {
    lines.push('');
    lines.push('Preview URLs (use these as Playwright `baseURL` — the bundled');
    lines.push('playwright.config.ts already wires `process.env.PLAYWRIGHT_BASE_URL`);');
    lines.push('only override per-test for non-primary services):');
    for (const { key, value } of previewUrls) {
      lines.push(`  ${key}: ${value}`);
    }
  }

  lines.push('');
  lines.push('Use this from inside the project container — the env var');
  lines.push('PLAYWRIGHT_WS_ENDPOINT is already set to the same value.');
  lines.push('In Playwright Test, the bundled playwright.config.ts already');
  lines.push('reads it via `connectOptions.wsEndpoint`. NEVER call');
  lines.push('`playwright install` or `apt-get install` — the browser lives');
  lines.push('in the shared Chrome Service, not in this container.');
  lines.push('Use RELATIVE goto paths (e.g. `page.goto(\'/login\')`) — the');
  lines.push('cookie + base URL are wired by globalSetup.');
  return lines.join('\n');
}

/**
 * B7 — pure: reply for the WORKER path, where the ChromeService
 * singleton is unavailable but the env-store probe succeeded. Mirrors
 * the running-state reply minus the fields only the singleton knows
 * (image). Exported for unit tests.
 */
export function formatEnvProbeReply(
  wsEndpoint: string,
  previewUrls: Array<{ key: string; value: string }> = [],
): string {
  const lines = [
    `wsEndpoint: ${wsEndpoint}`,
    'alive:      true (probed via session env PLAYWRIGHT_WS_ENDPOINT)',
  ];
  if (previewUrls.length > 0) {
    lines.push('');
    lines.push('Preview URLs (use these as Playwright `baseURL`):');
    for (const { key, value } of previewUrls) {
      lines.push(`  ${key}: ${value}`);
    }
  }
  lines.push('');
  lines.push('Use this from inside the project container — the env var');
  lines.push('PLAYWRIGHT_WS_ENDPOINT is already set to the same value.');
  lines.push('NEVER call `playwright install` — the browser lives in the');
  lines.push('shared Chrome Service, not in this container.');
  return lines.join('\n');
}

export function qaGetBrowserEndpoint(
  orchestrator: CompanyOrchestrator,
  agentRole: string,
  agentRunId: string | null,
): CoderTool {
  void agentRole;
  void agentRunId;
  return {
    name: 'qa_get_browser_endpoint',
    description:
      'Return the WebSocket URL the QA agent should pass to `chromium.connect({wsEndpoint})`. The browser runs in a shared Chrome Service container managed by the operator in Admin → Chrome Service — never install a browser locally. The reply also includes a live healthcheck of the service AND the preview URLs (PLAYWRIGHT_BASE_URL_*) the QA browser must navigate to via the http-api proxy.',
    parameters: PARAMETERS,
    source: 'native',
    handler: async () => {
      try {
        const sessionId = orchestrator.companySessionId;
        const previewUrls = collectPlaywrightBaseUrls(getQaEndpointEnvStore(), sessionId);
        const svc = tryGetChromeService();
        if (!svc) {
          // B7 — worker path: the singleton doesn't cross worker threads,
          // but the session env store always carries PLAYWRIGHT_WS_ENDPOINT.
          // The preflight probes the equivalent loopback URL with
          // retry + breaker instead of giving up immediately.
          const pf = await preflightBrowser({ sessionId });
          if (pf.ok && pf.wsEndpoint) {
            return ok(formatEnvProbeReply(pf.wsEndpoint, previewUrls));
          }
          return ok(
            formatBrowserEndpointReply(null, { ok: false, error: pf.message }, previewUrls),
          );
        }
        const state = await svc.getEndpoint({ probe: false });
        if (state.status !== 'running') {
          return ok(formatBrowserEndpointReply(state, { ok: false }, previewUrls));
        }
        // B7 — same preflight wrapper as qa_start_run (replaces the old
        // single 4s probe): retry/backoff + per-session circuit breaker.
        const pf = await preflightBrowser({ sessionId });
        const health: SidecarVersionInfo = pf.ok
          ? { ok: true }
          : { ok: false, error: pf.message };
        return ok(formatBrowserEndpointReply(state, health, previewUrls));
      } catch (e) {
        return err(`qa_get_browser_endpoint failed: ${(e as Error).message}`);
      }
    },
  };
}
