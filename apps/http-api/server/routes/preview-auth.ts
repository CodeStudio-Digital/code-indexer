/**
 * HMAC token helpers — leftover from the now-removed sandbox preview
 * proxy (Phase C of the "living company" restructure). The proxy
 * itself is gone, so token verification no longer happens; what
 * remains is the long-lived QA token that the sandbox manager still
 * injects as `MCP_PREVIEW_COOKIE` into Playwright-enabled containers
 * (the agent CLI persists it for cross-container fetches that we may
 * route through a different mechanism later).
 *
 * If/when QA is rewired to use the direct host port (no token needed)
 * this module can be deleted along with the `MCP_PREVIEW_COOKIE`
 * managed env and the corresponding scaffolder bootstrap.
 */

import { createHmac, randomBytes } from 'node:crypto';

const DEFAULT_TTL_MS = 30 * 60 * 1000;

/**
 * Long-lived TTL for tokens injected into QA-enabled sandbox containers
 * (v4.3). `syncManagedEnvs` re-mints when the persisted token has
 * <7 days left, so 30d gives plenty of slack.
 *
 * Operator override: `MCP_QA_PREVIEW_TTL_MS` (milliseconds).
 */
export const QA_PREVIEW_TTL_MS =
  Number(process.env.MCP_QA_PREVIEW_TTL_MS) || 30 * 24 * 60 * 60 * 1000;

/**
 * Pure: parse the `exp` epoch (ms) out of a minted cookie value.
 * Returns `null` for malformed values. Used by `syncManagedEnvs` to
 * decide whether the persisted token still has enough headroom or
 * needs a re-mint.
 */
export function parseTokenExpiry(value: string | undefined): number | null {
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const exp = Number(parts[1]);
  return Number.isFinite(exp) ? exp : null;
}

let cachedSecret: Buffer | null = null;
function getSecret(): Buffer {
  if (cachedSecret) return cachedSecret;
  const fromEnv = process.env.MCP_PREVIEW_SECRET;
  if (fromEnv && fromEnv.length >= 32) {
    cachedSecret = Buffer.from(fromEnv, 'utf-8');
  } else {
    // 32 bytes is enough for HMAC-SHA256. Generated per-process so
    // crashes force a token refresh — desirable since sandbox state
    // doesn't outlive the process either.
    cachedSecret = randomBytes(32);
  }
  return cachedSecret;
}

interface MintedPreviewToken {
  value: string;
  /** epoch ms at which a hypothetical verifier would reject the cookie. */
  expiresAt: number;
}

/** Build the signed token value for `sessionId` with a sliding `ttlMs`. */
export function mintPreviewToken(sessionId: string, ttlMs = DEFAULT_TTL_MS): MintedPreviewToken {
  const exp = Date.now() + ttlMs;
  const payload = `${sessionId}.${exp}`;
  const hmac = createHmac('sha256', getSecret()).update(payload).digest('hex');
  return { value: `${payload}.${hmac}`, expiresAt: exp };
}
