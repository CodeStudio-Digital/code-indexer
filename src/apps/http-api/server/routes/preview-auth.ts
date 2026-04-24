/**
 * HMAC-signed cookie authentication for the sandbox preview proxy.
 *
 * Threat model:
 *   - The sandbox container hosts arbitrary code the LLM just wrote. We
 *     don't want that origin reachable from the rest of the network
 *     without proof that the request came from the same dashboard user
 *     who created the session.
 *   - The iframe is same-origin with the dashboard, so a simple signed
 *     cookie scoped to `/preview/` is enough: the dashboard mints it
 *     right before setting the iframe src, and the proxy (HTTP + WS
 *     upgrade) checks it on every request.
 *
 * Design:
 *   - Cookie value: `<sessionId>.<exp-epoch-ms>.<hmac>` where
 *     `hmac = HMAC-SHA256(secret, "<sessionId>.<exp>")`.
 *   - `sessionId` is URL-safe (encodeURIComponent caller-side).
 *   - `exp` is an absolute expiry in ms. Proxy rejects cookies past it.
 *   - The secret is `MCP_PREVIEW_SECRET` (env). When absent, a
 *     process-local random secret is generated — this means cookies
 *     don't survive restarts but the dashboard transparently mints a
 *     new one on poll, so the UX is unaffected.
 *
 * We intentionally don't use JWT: no claims needed, and the dep-free
 * string format keeps the WS-upgrade validator tiny (no parser chain).
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const PREVIEW_COOKIE = 'mcp_preview';
const DEFAULT_TTL_MS = 30 * 60 * 1000;

let cachedSecret: Buffer | null = null;
function getSecret(): Buffer {
  if (cachedSecret) return cachedSecret;
  const fromEnv = process.env.MCP_PREVIEW_SECRET;
  if (fromEnv && fromEnv.length >= 32) {
    cachedSecret = Buffer.from(fromEnv, 'utf-8');
  } else {
    // 32 bytes is enough for HMAC-SHA256. Generated per-process so
    // crashes force a cookie refresh — desirable since sandbox state
    // doesn't outlive the process either (Phase 5c archive aside, which
    // is restored via disk independently).
    cachedSecret = randomBytes(32);
  }
  return cachedSecret;
}

export interface MintedPreviewToken {
  value: string;
  /** epoch ms at which the proxy will reject this cookie. */
  expiresAt: number;
}

/** Build the signed cookie value for `sessionId` with a sliding `ttlMs`. */
export function mintPreviewToken(sessionId: string, ttlMs = DEFAULT_TTL_MS): MintedPreviewToken {
  const exp = Date.now() + ttlMs;
  const payload = `${sessionId}.${exp}`;
  const hmac = createHmac('sha256', getSecret()).update(payload).digest('hex');
  return { value: `${payload}.${hmac}`, expiresAt: exp };
}

/**
 * Validate a cookie value against a required `sessionId`. Returns true
 * only when the HMAC matches, the session matches, and the token is
 * not expired.
 */
export function verifyPreviewToken(rawCookie: string | undefined, sessionId: string): boolean {
  if (!rawCookie) return false;
  // Cookie header may carry multiple pairs; pluck ours out.
  const pair = rawCookie
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${PREVIEW_COOKIE}=`));
  if (!pair) return false;
  const value = pair.slice(PREVIEW_COOKIE.length + 1);

  const parts = value.split('.');
  if (parts.length !== 3) return false;
  const [sid, expStr, hmacHex] = parts;
  if (sid !== sessionId) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;

  const expected = createHmac('sha256', getSecret()).update(`${sid}.${exp}`).digest('hex');
  // Constant-time compare to deny timing-oracle attacks on the secret.
  try {
    const a = Buffer.from(hmacHex, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Format a `Set-Cookie` header that installs the preview token. Scoped
 * to `/preview/` so it's never sent with normal API requests; `HttpOnly`
 * blocks JS access; `SameSite=Strict` blocks CSRF; `Secure` on HTTPS.
 */
export function formatSetCookie(token: MintedPreviewToken, opts: { secure: boolean } = { secure: false }): string {
  const parts = [
    `${PREVIEW_COOKIE}=${token.value}`,
    'Path=/preview/',
    `Expires=${new Date(token.expiresAt).toUTCString()}`,
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}
