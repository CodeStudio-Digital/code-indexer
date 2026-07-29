/**
 * B7 — browser preflight shared by `qa_start_run` and
 * `qa_get_browser_endpoint`: is the shared Chrome Service reachable
 * RIGHT NOW? Replaces the old single 4s probe with retry + backoff and
 * a per-session circuit breaker so a dead sidecar fails fast instead of
 * burning agent turns.
 *
 * Dual source:
 *   (a) MAIN process — `tryGetChromeService()` returns the singleton;
 *       we probe its `loopbackHealthUrl`.
 *   (b) WORKER (singleton is null — module globals don't cross workers)
 *       — read `PLAYWRIGHT_WS_ENDPOINT` from the session env store
 *       (always persisted in `company_session_envs`) and probe the
 *       equivalent loopback HTTP URL. The ws host is the CONTAINER
 *       alias (`host.containers.internal`) which may not resolve in the
 *       host process (see `ChromeService.connectBrowser`), but the
 *       container publishes the same port on the host — so
 *       `http://127.0.0.1:<port>/` is the correct probe target.
 */
import { tryGetChromeService } from '@mcp/services/chrome-service/chrome-service.js';
import type { CompanySessionEnvStore } from '@mcp/store/company-session-env-store.js';
import { fetchSidecarVersion, getQaEndpointEnvStore } from './qa-get-browser-endpoint.js';

// ─── Pure retry core ─────────────────────────────────────────────

export interface ProbeOutcome { ok: boolean; atMs: number }

/** Backoff after the Nth consecutive failure. 1 initial try + 3 retries. */
export const RETRY_BACKOFF_MS: readonly number[] = [1_000, 3_000, 9_000];

export type RetryDecision =
  | { action: 'ok' }
  | { action: 'retry'; delayMs: number }
  | { action: 'give_up' };

/**
 * Pure: given the probes so far, decide the next step. `nowMs` lets the
 * delay account for time already spent since the last attempt.
 */
export function planRetry(outcomes: readonly ProbeOutcome[], nowMs: number): RetryDecision {
  const last = outcomes[outcomes.length - 1];
  if (!last) return { action: 'retry', delayMs: 0 }; // nothing probed yet
  if (last.ok) return { action: 'ok' };
  const failures = outcomes.filter((o) => !o.ok).length;
  if (failures > RETRY_BACKOFF_MS.length) return { action: 'give_up' };
  const backoff = RETRY_BACKOFF_MS[failures - 1] ?? 0;
  return { action: 'retry', delayMs: Math.max(0, backoff - (nowMs - last.atMs)) };
}

// ─── Per-session circuit breaker (module-level) ──────────────────

export const BREAKER_WINDOW_MS = 60_000;
const breakerBySession = new Map<string, number>(); // sessionId → trippedAtMs

export function isBreakerOpen(sessionId: string, nowMs: number): boolean {
  const at = breakerBySession.get(sessionId);
  if (at == null) return false;
  if (nowMs - at >= BREAKER_WINDOW_MS) {
    breakerBySession.delete(sessionId);
    return false;
  }
  return true;
}

export function tripBreaker(sessionId: string, nowMs: number): void {
  breakerBySession.set(sessionId, nowMs);
}

export function clearBreaker(sessionId: string): void {
  breakerBySession.delete(sessionId);
}

/** Test helper — wipe breaker state between cases. */
export function resetAllBreakers(): void {
  breakerBySession.clear();
}

// ─── Probe URL derivation (pure) ─────────────────────────────────

/**
 * ws://host.containers.internal:9223/ → http://127.0.0.1:9223/
 * Null for anything that isn't a ws(s) URL.
 */
export function probeUrlFromWsEndpoint(ws: string): string | null {
  try {
    const u = new URL(ws.trim());
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return null;
    const port = u.port || (u.protocol === 'wss:' ? '443' : '80');
    return `http://127.0.0.1:${port}/`;
  } catch {
    return null;
  }
}

// ─── Preflight ───────────────────────────────────────────────────

const PROBE_TIMEOUT_MS = 2_500;

export const PREFLIGHT_ACTION =
  'Ask the operator to start/restart the Chrome Service in Admin → Chrome Service. ' +
  'Do NOT install a browser locally (`playwright install` is forbidden — the browser ' +
  'lives in the shared Chrome Service container).';

interface ChromeServicePort {
  getEndpoint(opts?: { probe?: boolean }): Promise<{
    status: string;
    wsEndpoint: string;
    loopbackHealthUrl: string;
    lastError: string | null;
  }>;
}

export interface PreflightDeps {
  sessionId: string;
  /** Test seams — production callers pass only `sessionId`. */
  getChromeService?: () => ChromeServicePort | null;
  envStore?: CompanySessionEnvStore | null;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface PreflightResult {
  ok: boolean;
  source: 'chrome_service' | 'env_probe';
  attempts: number;
  breakerOpen: boolean;
  errorClass?: 'sidecar_down';
  /** Agent-facing detail; on failure it embeds `PREFLIGHT_ACTION`. */
  message: string;
  wsEndpoint?: string;
}

function fail(
  source: PreflightResult['source'],
  attempts: number,
  detail: string,
  breakerOpen = false,
): PreflightResult {
  return {
    ok: false, source, attempts, breakerOpen, errorClass: 'sidecar_down',
    message: `${detail} ${PREFLIGHT_ACTION}`,
  };
}

export async function preflightBrowser(deps: PreflightDeps): Promise<PreflightResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const fetchImpl = deps.fetchImpl ?? fetch;
  const svc = (deps.getChromeService ?? tryGetChromeService)();
  const source: PreflightResult['source'] = svc ? 'chrome_service' : 'env_probe';

  if (isBreakerOpen(deps.sessionId, now())) {
    return fail(source, 0,
      'Chrome Service preflight failed less than 60s ago (circuit breaker open — not re-probing).',
      true);
  }

  let probeUrl: string;
  let wsEndpoint: string | undefined;
  if (svc) {
    const state = await svc.getEndpoint({ probe: false });
    if (state.status !== 'running') {
      tripBreaker(deps.sessionId, now());
      return fail(source, 0,
        `Chrome Service is ${state.status}${state.lastError ? ` (${state.lastError})` : ''}.`);
    }
    probeUrl = state.loopbackHealthUrl;
    wsEndpoint = state.wsEndpoint;
  } else {
    const store = deps.envStore !== undefined ? deps.envStore : getQaEndpointEnvStore();
    const row = store?.list(deps.sessionId)
      .find((r) => r.key === 'PLAYWRIGHT_WS_ENDPOINT');
    const url = row?.value ? probeUrlFromWsEndpoint(row.value) : null;
    if (!url) {
      tripBreaker(deps.sessionId, now());
      return fail(source, 0,
        'PLAYWRIGHT_WS_ENDPOINT is not set for this session — the Chrome Service was never wired.');
    }
    probeUrl = url;
    wsEndpoint = row?.value;
  }

  const outcomes: ProbeOutcome[] = [];
  for (;;) {
    const decision = planRetry(outcomes, now());
    if (decision.action === 'ok') {
      clearBreaker(deps.sessionId);
      return {
        ok: true, source, attempts: outcomes.length, breakerOpen: false,
        message: 'Chrome Service healthy.', wsEndpoint,
      };
    }
    if (decision.action === 'give_up') {
      tripBreaker(deps.sessionId, now());
      const lastErr = outcomes.length > 0 ? 'health probe kept failing' : 'no probe executed';
      return fail(source, outcomes.length,
        `Chrome Service did not answer after ${outcomes.length} attempt(s) (${lastErr}).`);
    }
    if (decision.delayMs > 0) await sleep(decision.delayMs);
    const probe = await fetchSidecarVersion(probeUrl, fetchImpl, PROBE_TIMEOUT_MS);
    outcomes.push({ ok: probe.ok, atMs: now() });
  }
}
