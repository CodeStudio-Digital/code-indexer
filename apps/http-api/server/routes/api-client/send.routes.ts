import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, parseJsonBody } from '../_helpers.js';
import { requestInProject, resolveScopedEnv } from './_ownership.js';
import { blockPrivateHosts, projectRoot } from './_net-policy.js';
import { type CookieJar, createJar, jarSnapshot } from '@mcp/shared/utils/http-engine.js';
import { parseEnvVariables } from '@mcp/services/api-client/request-builder.js';
import { executeRequest, type ExecRequest, type ExecuteResult } from '@mcp/services/api-client/execute-request.js';
import { UNSET } from '@mcp/services/api-client/script-runtime/types.js';
import { apiClientReadCap } from '@mcp/services/api-client/read-cap.js';

/** Response read cap for the API client (shared with the regression runner + agent). */
const READ_CAP = apiClientReadCap();

/** Map script variableUpdates (UNSET → null) for ApiClientStore.applyEnvVarUpdates. */
function toEnvUpdates(updates: Record<string, string>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(updates)) out[k] = v === UNSET ? null : v;
  return out;
}

/** The JSON the client expects from /send and /send-adhoc (shared shape). */
function sendPayload(res: ExecuteResult, jar: CookieJar, envUpdated: boolean, varKeys: string[]): Record<string, unknown> {
  return {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
    body: res.body,
    ms: res.ms,
    url: res.url,
    size: res.size,
    sizeExact: res.sizeExact,
    truncated: res.truncated,
    tests: [...(res.preScript?.tests ?? []), ...(res.testScript?.tests ?? [])],
    consoleLogs: [...(res.preScript?.consoleLogs ?? []), ...(res.testScript?.consoleLogs ?? [])],
    scriptError: res.preScript?.error ?? res.testScript?.error,
    cookies: jarSnapshot(jar, new URL(res.url).host),
    envUpdated,
    updatedVars: envUpdated ? varKeys : undefined,
  };
}

/**
 * "Send request" proxy. The browser cannot call a dev server cross-origin
 * with cookies, so the send happens server-side here: resolve {{vars}} from
 * the selected env, assemble the URL, reuse a per-collection cookie jar (so
 * login flows persist across requests), then persist last_status.
 */

// Per-collection cookie jars, keyed `apiclient-${projectId}-${cid}`. Kept in
// module scope so a login request and a follow-up share cookies within a
// collection (cleared implicitly on process restart — fine for a dev tool).
const jars = new Map<string, CookieJar>();
function jarFor(projectId: number, collectionId: number): CookieJar {
  const k = `apiclient-${projectId}-${collectionId}`;
  let j = jars.get(k);
  if (!j) { j = createJar(); jars.set(k, j); }
  return j;
}

/** Keep the timeline bounded — newest N sends per request. */
const HISTORY_KEEP = 50;

/**
 * Drop the query string before persisting a URL to the timeline. `res.url` is the
 * FULLY RESOLVED url (template-substituted {{secret}} + apikey-in-query auth), so
 * storing it verbatim would persist secrets at rest and serve them back via the
 * history route — bypassing the env masking. Origin+path is enough for the UI.
 */
function redactUrl(url: string): string {
  try { const u = new URL(url); return `${u.origin}${u.pathname}`; } catch { return url.split('?')[0]; }
}

/** Structural slice of ApiClientStore the send route needs for the timeline. */
interface HistoryStore {
  insertRequestHistory(input: {
    request_id: number; status?: number | null; ok: boolean;
    duration_ms?: number | null; url?: string | null; error?: string | null;
  }): void;
  pruneRequestHistory(requestId: number, keep?: number): number;
}

function recordHistory(
  store: HistoryStore,
  requestId: number,
  entry: { status: number | null; ok: boolean; duration_ms: number; url: string; error?: string },
): void {
  // Best-effort: a timeline write must never fail the actual send response.
  try {
    store.insertRequestHistory({
      request_id: requestId,
      ...entry,
      // Cap the error blob — a misbehaving endpoint could return a huge message.
      error: entry.error ? entry.error.slice(0, 2000) : undefined,
    });
    store.pruneRequestHistory(requestId, HISTORY_KEEP);
  } catch { /* non-fatal */ }
}

export function mountApiSendRoute(app: Hono, deps: ServerDeps): void {
  // R1 — `store` is resolved per-request via deps.apiClientFor(projectId).

  app.post('/api/projects/:projectId/api-client/requests/:rid/send', async (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.apiClientFor(projectId);
    const rid = parseIdParam(c, 'rid');
    // Cross-project isolation: a stale request id from the previous project
    // (project switch leaves the client holding it) must not resolve here.
    const req = requestInProject(store, projectId, rid);
    if (!req) return c.json({ error: `Request ${rid} not found` }, 404);

    const body = await parseJsonBody<{ envId?: number; persistVars?: boolean }>(c);
    // Resolve the env scoped to THIS project. A stale envId pointing at another
    // project's environment (its own base_url + secrets) is ignored → fall back
    // to this project's default. That was the cross-project "requests hit the
    // other API's base URL" bug, and also keeps applyEnvVarUpdates (below) from
    // writing script var updates into a foreign project's environment.
    const env = resolveScopedEnv(store, projectId, body.envId);
    const vars = parseEnvVariables(env?.variables_json);
    const baseUrl = env?.base_url ?? '';
    const jar = jarFor(projectId, req.collection_id);

    const t0 = Date.now();
    const block = blockPrivateHosts();
    let res;
    try {
      res = await executeRequest({
        request: req, baseUrl, variables: vars, jar, maxBytes: READ_CAP,
        blockPrivateHosts: block, fileRoot: projectRoot(deps, projectId), allowAbsoluteFiles: !block,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // An unresolvable URL (no base URL set) is a config error, not a 502.
      if (/Invalid URL|could not|resolve/i.test(msg) && !/ECONN|timed out|socket/i.test(msg)) {
        return c.json({ error: `Could not resolve URL from base '${baseUrl}' + path '${req.path_template}'. Set a base URL in the environment.` }, 422);
      }
      recordHistory(store, rid, { status: null, ok: false, duration_ms: Date.now() - t0, url: req.path_template, error: msg });
      return c.json({ error: msg, url: req.path_template }, 502);
    }

    store.updateRequest(rid, { last_status: res.status, last_run_at: new Date().toISOString() });
    recordHistory(store, rid, { status: res.status, ok: res.status < 400, duration_ms: res.ms, url: redactUrl(res.url) });

    // Persist script var updates back to the env (default on for manual sends).
    const varKeys = Object.keys(res.variableUpdates);
    let envUpdated = false;
    if (body.persistVars !== false && env && varKeys.length) {
      try { store.applyEnvVarUpdates(env.id, toEnvUpdates(res.variableUpdates)); envUpdated = true; } catch { /* non-fatal */ }
    }

    return c.json(sendPayload(res, jar, envUpdated, varKeys));
  });

  // Ad-hoc send for an UNSAVED draft request — runs the request from the posted
  // body (no DB row). Mirrors /send but reads the request fields from the client
  // and uses a scratch jar. Script var-sets still persist to the selected env.
  app.post('/api/projects/:projectId/api-client/send-adhoc', async (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.apiClientFor(projectId);
    const body = await parseJsonBody<{ request?: ExecRequest; envId?: number; persistVars?: boolean }>(c);
    if (!body.request) return c.json({ error: 'request is required' }, 400);

    const env = resolveScopedEnv(store, projectId, body.envId);
    const vars = parseEnvVariables(env?.variables_json);
    const baseUrl = env?.base_url ?? '';
    const jar = jarFor(projectId, 0); // scratch jar — isolates ad-hoc cookies from collections

    const block = blockPrivateHosts();
    let res;
    try {
      res = await executeRequest({
        request: body.request, baseUrl, variables: vars, jar, maxBytes: READ_CAP,
        blockPrivateHosts: block, fileRoot: projectRoot(deps, projectId), allowAbsoluteFiles: !block,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/Invalid URL|could not|resolve/i.test(msg) && !/ECONN|timed out|socket/i.test(msg)) {
        return c.json({ error: `Could not resolve URL from base '${baseUrl}' + path '${body.request.path_template}'. Set a base URL in the environment.` }, 422);
      }
      return c.json({ error: msg, url: body.request.path_template }, 502);
    }

    const varKeys = Object.keys(res.variableUpdates);
    let envUpdated = false;
    if (body.persistVars !== false && env && varKeys.length) {
      try { store.applyEnvVarUpdates(env.id, toEnvUpdates(res.variableUpdates)); envUpdated = true; } catch { /* non-fatal */ }
    }
    return c.json(sendPayload(res, jar, envUpdated, varKeys));
  });

  // Per-request timeline — newest first, capped by HISTORY_KEEP on write.
  app.get('/api/projects/:projectId/api-client/requests/:rid/history', (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const store = deps.apiClientFor(projectId);
    const rid = parseIdParam(c, 'rid');
    // A stale rid from another project must not leak its send timeline (urls,
    // statuses, error blobs) under this project's route.
    if (!requestInProject(store, projectId, rid)) return c.json({ history: [] });
    // Clamp to [1, HISTORY_KEEP] — a negative limit becomes "unlimited" in SQLite.
    const limit = Math.max(1, Math.min(Number(c.req.query('limit') ?? HISTORY_KEEP) || HISTORY_KEEP, HISTORY_KEEP));
    return c.json({ history: store.listRequestHistory(rid, limit) });
  });
}
