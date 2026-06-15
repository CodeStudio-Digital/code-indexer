/**
 * http-engine — transport + cookie-jar primitives for making real HTTP/HTTPS
 * requests against a live backend (localhost or remote).
 *
 * Pure node:http/https with ZERO workspace deps, so it lives in @mcp/shared
 * and backs three callers without creating a cycle: the `http_request`
 * CoderTool (@mcp/code-agent), the API-client "send" route (apps/http-api),
 * and the non-LLM regression runner (@mcp/services). Presentation concerns
 * (LLM body truncation, formatted result lines) stay with each caller — the
 * engine only does the request and the cookie bookkeeping.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/** Hard read ceiling — never buffer more than this from a single response. */
export const READ_CAP = 512 * 1024;

export interface RawResponse {
  status: number;
  statusText: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

// ─── Cookie jar (host → name → value) ──────────────────────────────────────
/** A single cookie jar. Callers keep their own keyed registry of jars. */
export type CookieJar = Map<string, Map<string, string>>;

export function createJar(): CookieJar {
  return new Map();
}

export function cookieHeaderFor(jar: CookieJar, host: string): string {
  const m = jar.get(host);
  if (!m || m.size === 0) return '';
  return [...m.entries()].map(([n, v]) => `${n}=${v}`).join('; ');
}

export function storeSetCookies(jar: CookieJar, host: string, setCookie?: string[] | string): void {
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

export function isLoopbackHost(host: string): boolean {
  return /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i.test(host);
}

// ─── Transport ─────────────────────────────────────────────────────────────
export function doRequest(o: {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: string;
  insecure: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const isHttps = o.url.protocol === 'https:';
    const reqFn = isHttps ? httpsRequest : httpRequest;
    const req = reqFn(
      o.url,
      {
        method: o.method,
        headers: o.headers,
        ...(isHttps ? { rejectUnauthorized: !o.insecure } : {}),
        ...(o.signal ? { signal: o.signal } : {}),
      },
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

// ─── High-level send (jar-aware, used by the route + regression runner) ─────
export interface SendOptions {
  url: URL;
  method?: string;
  headers?: Record<string, string>;
  /** JSON body — serialized and sent as application/json (overrides `body`). */
  json?: unknown;
  body?: string;
  /** Accept self-signed TLS. Defaults to true for loopback hosts. */
  insecure?: boolean;
  /** Timeout in ms — clamped to [1000, 120000]. Default 30000. */
  timeoutMs?: number;
  /** Cookie jar to read prior cookies from and store Set-Cookie into. */
  jar?: CookieJar;
  signal?: AbortSignal;
}

/**
 * Apply jar cookies, serialize a JSON body, perform the request, then persist
 * any Set-Cookie back into the jar. Returns the raw response untouched.
 */
export async function sendHttp(o: SendOptions): Promise<RawResponse> {
  const method = String(o.method ?? 'GET').toUpperCase();
  const timeoutMs = Math.min(120_000, Math.max(1_000, Number(o.timeoutMs ?? 30_000)));
  const insecure = o.insecure != null ? !!o.insecure : isLoopbackHost(o.url.hostname);

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.headers ?? {})) headers[k] = String(v);

  let body: string | undefined;
  if (o.json !== undefined && o.json !== null) {
    body = JSON.stringify(o.json);
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
      headers['content-type'] = 'application/json';
    }
  } else if (typeof o.body === 'string') {
    body = o.body;
  }

  if (o.jar) {
    const jarCookie = cookieHeaderFor(o.jar, o.url.host);
    if (jarCookie) {
      const existing = Object.entries(headers).find(([h]) => h.toLowerCase() === 'cookie');
      headers[existing ? existing[0] : 'cookie'] = existing ? `${existing[1]}; ${jarCookie}` : jarCookie;
    }
  }

  const res = await doRequest({ url: o.url, method, headers, body, insecure, timeoutMs, signal: o.signal });
  if (o.jar) storeSetCookies(o.jar, o.url.host, res.headers['set-cookie']);
  return res;
}
