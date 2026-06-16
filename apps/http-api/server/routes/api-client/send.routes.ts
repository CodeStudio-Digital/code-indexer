import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, parseJsonBody } from '../_helpers.js';
import { type CookieJar, createJar, sendHttp } from '@mcp/shared/utils/http-engine.js';
import {
  buildUrl, parseEnvVariables, parseMap, resolveMap, resolveTemplate,
} from '@mcp/services/api-client/request-builder.js';

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
  const store = deps.apiClientStore;

  app.post('/api/projects/:projectId/api-client/requests/:rid/send', async (c) => {
    const projectId = parseIdParam(c, 'projectId');
    const rid = parseIdParam(c, 'rid');
    const req = store.getRequest(rid);
    if (!req) return c.json({ error: `Request ${rid} not found` }, 404);

    const body = await parseJsonBody<{ envId?: number }>(c);
    const env = body.envId != null
      ? store.getEnvironment(body.envId)
      : store.getDefaultEnvironment(projectId);
    const vars = parseEnvVariables(env?.variables_json);
    const baseUrl = env?.base_url ?? '';

    let url: URL;
    try {
      url = buildUrl(baseUrl, req.path_template, parseMap(req.query_json), vars);
    } catch {
      return c.json({ error: `Could not resolve URL from base '${baseUrl}' + path '${req.path_template}'. Set a base URL in the environment.` }, 422);
    }

    const headers = resolveMap(parseMap(req.headers_json), vars);
    let outBody: string | undefined;
    if (req.body_kind !== 'none' && req.body_json != null) {
      outBody = resolveTemplate(req.body_json, vars);
      if (req.body_kind === 'json' && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
        headers['content-type'] = 'application/json';
      }
    }

    const t0 = Date.now();
    try {
      const res = await sendHttp({
        url, method: req.method, headers, body: outBody,
        jar: jarFor(projectId, req.collection_id),
      });
      const ms = Date.now() - t0;
      store.updateRequest(rid, { last_status: res.status, last_run_at: new Date().toISOString() });
      recordHistory(store, rid, { status: res.status, ok: res.status < 400, duration_ms: ms, url: url.href });
      return c.json({
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
        body: res.body,
        ms,
        url: url.href,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      recordHistory(store, rid, { status: null, ok: false, duration_ms: Date.now() - t0, url: url.href, error: msg });
      return c.json({ error: msg, url: url.href }, 502);
    }
  });

  // Per-request timeline — newest first, capped by HISTORY_KEEP on write.
  app.get('/api/projects/:projectId/api-client/requests/:rid/history', (c) => {
    const rid = parseIdParam(c, 'rid');
    // Clamp to [1, HISTORY_KEEP] — a negative limit becomes "unlimited" in SQLite.
    const limit = Math.max(1, Math.min(Number(c.req.query('limit') ?? HISTORY_KEEP) || HISTORY_KEEP, HISTORY_KEEP));
    return c.json({ history: store.listRequestHistory(rid, limit) });
  });
}
