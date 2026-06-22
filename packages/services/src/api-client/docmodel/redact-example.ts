/**
 * redact-example — server-authoritative redaction for SAVED examples (the doc
 * "examples that don't lie"). A captured request/response can carry tokens, so
 * this is applied on WRITE and never trusts the client's strip. It (1) drops
 * sensitive headers entirely, (2) masks exact env-secret values, (3) masks
 * credential-shaped substrings (JWT, sk-/Bearer, credential query params), and
 * (4) drops the URL query string. Returns the row-ready shape + a redaction count.
 */
const PLACEHOLDER = '«redacted»';

const SENSITIVE_HEADERS = new Set([
  'authorization', 'cookie', 'set-cookie', 'proxy-authorization',
  'x-api-key', 'x-auth-token', 'x-amz-security-token', 'x-csrf-token',
]);

export interface ExampleCapture {
  name: string;
  req: { method: string; url: string; headers?: Record<string, string>; body?: string | null; bodyKind?: string };
  resp: { status: number | null; statusText: string | null; headers?: Record<string, string>; body?: string | null; contentType?: string | null; size?: number | null };
}

export interface RedactedExample {
  req_snapshot_json: string;
  resp_status: number | null;
  resp_status_text: string | null;
  resp_headers_json: string;
  resp_body: string | null;
  resp_content_type: string | null;
  resp_size: number | null;
  redaction_count: number;
}

/** Mask credential-shaped substrings + exact env secrets in arbitrary text. */
function redactText(input: string, secrets: string[]): { text: string; count: number } {
  let count = 0;
  let out = input;
  const sub = (re: RegExp, replacer: (m: string, ...g: string[]) => string): void => {
    out = out.replace(re, (...args) => { count++; return replacer(args[0] as string, ...(args.slice(1) as string[])); });
  };
  // Exact env-secret values first (longest first so substrings don't shadow).
  for (const s of [...secrets].filter((x) => x && x.length >= 4).sort((a, b) => b.length - a.length)) {
    const parts = out.split(s);
    if (parts.length > 1) { count += parts.length - 1; out = parts.join(PLACEHOLDER); }
  }
  sub(/eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, () => PLACEHOLDER); // JWT
  sub(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, () => PLACEHOLDER);
  sub(/\b(?:ghp|gho|ghu|ghs|xoxb|xoxp|AKIA)[A-Za-z0-9_-]{10,}/g, () => PLACEHOLDER);
  sub(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._\-+/=]{12,}/gi, (_m, scheme) => `${scheme} ${PLACEHOLDER}`);
  sub(/([?&](?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd|key|sig|signature)=)([^&\s#]{6,})/gi, (_m, prefix) => `${prefix}${PLACEHOLDER}`);
  return { text: out, count };
}

function redactHeaders(headers: Record<string, string> | undefined, secrets: string[]): { headers: Record<string, string>; count: number } {
  const out: Record<string, string> = {};
  let count = 0;
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (SENSITIVE_HEADERS.has(k.toLowerCase())) { out[k] = PLACEHOLDER; count++; continue; }
    const r = redactText(String(v), secrets);
    out[k] = r.text; count += r.count;
  }
  return { headers: out, count };
}

/** Drop the query string from a URL (resolved query may carry secrets). */
function stripQuery(url: string): string {
  try { const u = new URL(url); return `${u.origin}${u.pathname}`; } catch { return url.split('?')[0]; }
}

const MAX_BODY = 256 * 1024;

export function redactExample(capture: ExampleCapture, secrets: string[]): RedactedExample {
  let count = 0;
  const reqHeaders = redactHeaders(capture.req.headers, secrets); count += reqHeaders.count;
  const reqBody = capture.req.body ? redactText(capture.req.body.slice(0, MAX_BODY), secrets) : { text: capture.req.body ?? null, count: 0 };
  count += reqBody.count;
  const respHeaders = redactHeaders(capture.resp.headers, secrets); count += respHeaders.count;
  const respBody = capture.resp.body ? redactText(capture.resp.body.slice(0, MAX_BODY), secrets) : { text: capture.resp.body ?? null, count: 0 };
  count += respBody.count;

  const reqSnapshot = {
    method: capture.req.method,
    url: stripQuery(capture.req.url),
    headers: reqHeaders.headers,
    body: reqBody.text,
    bodyKind: capture.req.bodyKind ?? null,
  };

  return {
    req_snapshot_json: JSON.stringify(reqSnapshot),
    resp_status: capture.resp.status,
    resp_status_text: capture.resp.statusText,
    resp_headers_json: JSON.stringify(respHeaders.headers),
    resp_body: respBody.text,
    resp_content_type: capture.resp.contentType ?? null,
    resp_size: capture.resp.size ?? null,
    redaction_count: count,
  };
}
