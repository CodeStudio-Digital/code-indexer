/**
 * http_request — make real HTTP/HTTPS requests to test a LIVE backend
 * (localhost or remote) with method/headers/JSON|body, returning status +
 * headers + body. Unlike `web_fetch` (public-page GET, SSRF-blocks loopback),
 * this ALLOWS localhost and self-signed TLS — the agent already has shell
 * (`run_command`/curl), so this is convenience + a per-session COOKIE JAR so
 * login flows work (POST /login → GET /me stays authenticated).
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { CoderTool, ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';

const BODY_CAP = 16 * 1024;
const READ_CAP = 512 * 1024;

// ─── Per-session cookie jar (host → name → value) ──────────────────────────
const jars = new Map<string, Map<string, Map<string, string>>>();

/** Stable per-agent key (mirrors preview's `previewKey`) so company
 *  subordinates sharing one worker don't cross-contaminate cookies. */
function sessionKey(ctx: ToolContext): string {
  const cc = ctx.companyContext as { agentRunId?: number; companySessionId?: number } | undefined;
  if (cc?.agentRunId != null) return `company-agent-${cc.agentRunId}`;
  if (cc?.companySessionId != null) return `company-session-${cc.companySessionId}`;
  return `coder-${ctx.sessionId ?? 'main'}`;
}
function jarFor(ctx: ToolContext): Map<string, Map<string, string>> {
  const k = sessionKey(ctx);
  let j = jars.get(k);
  if (!j) { j = new Map(); jars.set(k, j); }
  return j;
}
function cookieHeaderFor(jar: Map<string, Map<string, string>>, host: string): string {
  const m = jar.get(host);
  if (!m || m.size === 0) return '';
  return [...m.entries()].map(([n, v]) => `${n}=${v}`).join('; ');
}
function storeSetCookies(jar: Map<string, Map<string, string>>, host: string, setCookie?: string[] | string): void {
  if (!setCookie) return;
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  let m = jar.get(host);
  if (!m) { m = new Map(); jar.set(host, m); }
  for (const c of list) {
    const first = c.split(';')[0];
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (name) m.set(name, value);
  }
}

interface RawResponse { status: number; statusText: string; headers: Record<string, string | string[] | undefined>; body: string }

function doRequest(o: {
  url: URL; method: string; headers: Record<string, string>; body?: string; insecure: boolean; timeoutMs: number;
}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const isHttps = o.url.protocol === 'https:';
    const reqFn = isHttps ? httpsRequest : httpRequest;
    const req = reqFn(
      o.url,
      { method: o.method, headers: o.headers, ...(isHttps ? { rejectUnauthorized: !o.insecure } : {}) },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (c: Buffer) => { total += c.length; if (total <= READ_CAP) chunks.push(c); });
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          statusText: res.statusMessage ?? '',
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      },
    );
    req.setTimeout(o.timeoutMs, () => req.destroy(new Error(`request timed out after ${o.timeoutMs}ms`)));
    req.on('error', reject);
    if (o.body) req.write(o.body);
    req.end();
  });
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
    const timeoutMs = Math.min(120_000, Math.max(1_000, Number(args.timeoutMs ?? 30_000)));
    const isLoopback = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i.test(url.hostname);
    const insecure = args.insecure != null ? !!args.insecure : isLoopback;

    const jar = jarFor(ctx);
    if (args.resetCookies) jar.delete(url.host);

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((args.headers as Record<string, unknown>) ?? {})) headers[k] = String(v);

    let body: string | undefined;
    if (args.json !== undefined && args.json !== null) {
      body = JSON.stringify(args.json);
      if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
    } else if (typeof args.body === 'string') {
      body = args.body;
    }

    const jarCookie = cookieHeaderFor(jar, url.host);
    if (jarCookie) {
      const existing = Object.entries(headers).find(([h]) => h.toLowerCase() === 'cookie');
      headers[existing ? existing[0] : 'cookie'] = existing ? `${existing[1]}; ${jarCookie}` : jarCookie;
    }

    const t0 = Date.now();
    let res: RawResponse;
    try {
      res = await doRequest({ url, method, headers, body, insecure, timeoutMs });
    } catch (e) {
      return err(`http_request failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const ms = Date.now() - t0;
    storeSetCookies(jar, url.host, res.headers['set-cookie']);

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
