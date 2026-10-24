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
import { ok, err, unknownToolOutcome } from '@mcp/code-agent/core/tool.js';
import {
  assertMutationFence,
  combinedMutationSignal,
} from '@mcp/code-agent/core/mutation-fence.js';
import { READ_CAP, type CookieJar, createJar, isLoopbackHost, sendHttp } from '@mcp/shared/utils/http-engine.js';

const MAX_HTTP_READ_BYTES = 5 * 1024 * 1024;
const readMethods = new Set(['GET', 'HEAD', 'OPTIONS']);

// ─── Per-session cookie jar registry (sessionKey → jar) ────────────────────
const jars = new Map<string, CookieJar>();

/** Stable per-agent key (mirrors preview's `previewKey`) so company
 *  subordinates sharing one worker don't cross-contaminate cookies. */
function sessionKey(ctx: ToolContext): string {
  const cc = ctx.companyContext as { agentRunId?: string; companySessionId?: string } | undefined;
  if (cc?.agentRunId != null) return `company-agent-${cc.agentRunId}`;
  if (cc?.companySessionId != null) return `company-session-${cc.companySessionId}`;
  return `coder-${ctx.sessionId ?? 'main'}`;
}
export function httpSessionCookieJar(ctx: ToolContext): CookieJar {
  const k = sessionKey(ctx);
  let j = jars.get(k);
  if (!j) { j = createJar(); jars.set(k, j); }
  return j;
}

export const httpRequestTool: CoderTool = {
  name: 'http_request',
  effectBoundary: 'network',
  description:
    'Make a real HTTP/HTTPS request to a LIVE backend (localhost OR remote) to test an API — method + headers + JSON/body, returns status, headers and body. ' +
    'Keeps a per-session COOKIE JAR so login flows work: POST /login then GET /me stays authenticated without re-sending the cookie. ' +
    'Allows localhost and self-signed TLS (auto for loopback). For PUBLIC documentation pages use web_fetch; to call the API as the logged-in frontend (app cookies/origin) use preview_eval.',
  source: 'native',
  outputPolicy: { mode: 'structured', reducer: 'smart', recovery: 'output_store', preserveOnError: true },
  mutates: true,
  parallelSafe: false,
  riskLevel: 'execute',
  riskOf: input => readMethods.has(String((input as { method?: unknown } | undefined)?.method ?? 'GET').toUpperCase()) ? 'read' : 'execute',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Full URL (http:// or https://). localhost allowed.' },
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'], description: 'HTTP method (default GET).' },
      headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Request headers (e.g. Authorization).' },
      json: { type: 'object', description: 'JSON body — serialized and sent with content-type application/json (overrides body).' },
      body: { type: 'string', description: 'Raw request body (ignored if json is set).' },
      timeoutMs: { type: 'number', description: 'Timeout in milliseconds (default 30000, max 120000).' },
      insecure: { type: 'boolean', description: 'Allow self-signed TLS. Defaults to true only for loopback hosts.' },
      resetCookies: { type: 'boolean', description: 'Clear this session cookie jar for the target host before sending.' },
      maxBytes: {
        type: 'number',
        description: `Network acquisition ceiling in bytes (default ${READ_CAP}, max ${MAX_HTTP_READ_BYTES}). If reached, the transfer stops and the response is explicitly marked source-truncated.`,
      },
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
    const port = ctx.ports?.http;
    const jar = port ? undefined : httpSessionCookieJar(ctx);
    const signal = combinedMutationSignal(ctx.signal, ctx.mutationFence);
    let dispatched = false;

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((args.headers as Record<string, unknown>) ?? {})) headers[k] = String(v);

    const insecure = args.insecure != null ? !!args.insecure : isLoopbackHost(url.hostname);

    const t0 = Date.now();
    let res;
    try {
      const requestedMaxBytes = Number(args.maxBytes ?? READ_CAP);
      const maxBytes = Number.isFinite(requestedMaxBytes)
        ? Math.min(MAX_HTTP_READ_BYTES, Math.max(1024, Math.floor(requestedMaxBytes)))
        : READ_CAP;
      const beforeDispatch = () => {
        signal?.throwIfAborted();
        assertMutationFence(ctx.mutationFence, { kind: 'network', operation: method, resource: url.href });
      };
      beforeDispatch();
      if (args.resetCookies) jar?.delete(url.host);
      const send = port ? port.send.bind(port) : sendHttp;
      res = await send({
        url,
        method,
        headers,
        json: args.json,
        body: typeof args.body === 'string' ? args.body : undefined,
        insecure,
        timeoutMs: Number(args.timeoutMs ?? 30_000),
        maxBytes,
        jar,
        signal, resetCookies: !!args.resetCookies, beforeDispatch,
        onDispatch: () => { dispatched = true; },
      });
    } catch (e) {
      if (dispatched && !readMethods.has(method)) {
        port?.outcomeUnknown();
        return unknownToolOutcome(`http_request completion is unconfirmed: ${e instanceof Error ? e.message : String(e)}. Reconcile before retrying.`);
      }
      return err(`http_request failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const ms = Date.now() - t0;

    const ct = String(res.headers['content-type'] ?? '');
    const loc = res.headers['location'];
    const setC = res.headers['set-cookie'];
    const lines = [
      `${method} ${url.href} → ${res.status} ${res.statusText} (${ms}ms)`,
      ct ? `content-type: ${ct}` : '',
      loc ? `location: ${loc}` : '',
      setC ? `set-cookie: ${(Array.isArray(setC) ? setC : [setC]).length} cookie(s) stored for this session` : '',
      res.truncated
        ? `[source truncated: network read ceiling reached; source size ${res.sizeExact ? `was ${res.size}` : `is at least ${res.size}`} bytes. Transfer stopped for safety. Retry with pagination/Range or raise maxBytes (max ${MAX_HTTP_READ_BYTES}).]`
        : '',
      '',
      // The runner owns model-context shaping and sees the complete body that
      // passed the explicit network-acquisition boundary above.
      res.body || '(empty body)',
    ].filter((l) => l !== '');
    const content = lines.join('\n');
    return {
      content,
      ...(res.truncated
        ? {
            sourceTruncations: [{
              technique: 'network-acquisition-cap',
              inputSize: res.size,
              ...(res.sizeExact ? {} : { inputSizeExact: false }),
              outputSize: Buffer.byteLength(res.body, 'utf-8'),
              unit: 'bytes' as const,
              recoverable: false,
            }],
          }
        : {}),
    };
  },
};

export const httpTools: CoderTool[] = [httpRequestTool];
