/**
 * http_request — make real HTTP/HTTPS requests to test a LIVE backend
 * (localhost or remote) with method/headers/JSON|body, returning status +
 * headers + body. Unlike `web_fetch` (public-page GET, SSRF-blocks loopback),
 * this ALLOWS localhost and self-signed TLS — the agent already has shell
 * (`run_command`/curl), so this is convenience + a per-session COOKIE JAR so
 * login flows work (POST /login → GET /me stays authenticated).
 *
 * The transport + cookie primitives live in `http-engine.ts` (pure, shared
 * with the API-client route + regression runner). This file owns only the
 * tool wrapper and the per-session jar registry.
 */
import type { CoderTool, ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { type CookieJar, createJar, isLoopbackHost, sendHttp } from '@mcp/shared/utils/http-engine.js';

const BODY_CAP = 16 * 1024;

// ─── Per-session cookie jar registry (sessionKey → jar) ────────────────────
const jars = new Map<string, CookieJar>();

/** Stable per-agent key (mirrors preview's `previewKey`) so company
 *  subordinates sharing one worker don't cross-contaminate cookies. */
function sessionKey(ctx: ToolContext): string {
  const cc = ctx.companyContext as { agentRunId?: number; companySessionId?: number } | undefined;
  if (cc?.agentRunId != null) return `company-agent-${cc.agentRunId}`;
  if (cc?.companySessionId != null) return `company-session-${cc.companySessionId}`;
  return `coder-${ctx.sessionId ?? 'main'}`;
}
function jarFor(ctx: ToolContext): CookieJar {
  const k = sessionKey(ctx);
  let j = jars.get(k);
  if (!j) { j = createJar(); jars.set(k, j); }
  return j;
}

export const httpRequestTool: CoderTool = {
  name: 'http_request',
  description:
    'Make a real HTTP/HTTPS request to a LIVE backend (localhost OR remote) to test an API — method + headers + JSON/body, returns status, headers and body. ' +
    'Keeps a per-session COOKIE JAR so login flows work: POST /login then GET /me stays authenticated without re-sending the cookie. ' +
    'Allows localhost and self-signed TLS (auto for loopback). For PUBLIC documentation pages use web_fetch; to call the API as the logged-in frontend (app cookies/origin) use preview_eval.',
  source: 'native',
  mutates: false,
  parallelSafe: false,
  riskLevel: 'execute',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Full URL (http:// or https://). localhost allowed.' },
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'], description: 'HTTP method (default GET).' },
      headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Request headers (e.g. Authorization).' },
      json: { type: 'object', description: 'JSON body — serialized and sent with content-type application/json (overrides body).' },
      body: { type: 'string', description: 'Raw request body (ignored if json is set).' },
      insecure: { type: 'boolean', description: 'Accept self-signed TLS certs (auto-enabled for loopback hosts).' },
      timeoutMs: { type: 'number', description: 'Timeout in ms (default 30000, max 120000).' },
      resetCookies: { type: 'boolean', description: 'Clear this session\'s cookie jar before the request (fresh login).' },
    },
    required: ['url'],
    additionalProperties: false,
  },
  handler: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const raw = String(args.url ?? '').trim();
    if (!/^https?:\/\//i.test(raw)) return err(`url must start with http:// or https:// — got '${raw}'`);
    let url: URL;
    try { url = new URL(raw); } catch { return err(`invalid url '${raw}'`); }

    const method = String(args.method ?? 'GET').toUpperCase();
    const jar = jarFor(ctx);
    if (args.resetCookies) jar.delete(url.host);

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((args.headers as Record<string, unknown>) ?? {})) headers[k] = String(v);

    const insecure = args.insecure != null ? !!args.insecure : isLoopbackHost(url.hostname);

    const t0 = Date.now();
    let res;
    try {
      res = await sendHttp({
        url,
        method,
        headers,
        json: args.json,
        body: typeof args.body === 'string' ? args.body : undefined,
        insecure,
        timeoutMs: Number(args.timeoutMs ?? 30_000),
        jar,
        signal: ctx.signal,
      });
    } catch (e) {
      return err(`http_request failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const ms = Date.now() - t0;

    const ct = String(res.headers['content-type'] ?? '');
    const loc = res.headers['location'];
    const setC = res.headers['set-cookie'];
    const bodyOut = res.body.length > BODY_CAP ? `${res.body.slice(0, BODY_CAP)}\n… [truncated ${res.body.length - BODY_CAP} chars]` : res.body;
    const lines = [
      `${method} ${url.href} → ${res.status} ${res.statusText} (${ms}ms)`,
      ct ? `content-type: ${ct}` : '',
      loc ? `location: ${loc}` : '',
      setC ? `set-cookie: ${(Array.isArray(setC) ? setC : [setC]).length} cookie(s) stored for this session` : '',
      '',
      bodyOut || '(empty body)',
    ].filter((l) => l !== '');
    return ok(lines.join('\n'));
  },
};

export const httpTools: CoderTool[] = [httpRequestTool];
