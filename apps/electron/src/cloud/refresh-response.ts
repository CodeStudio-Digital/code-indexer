/**
 * Pure parser for POST /v1/auth/refresh. The rotated tokens are nested under
 * `session` (the SAME shape login returns) — reading them at the top level
 * silently failed every refresh and logged the user out. Extracted + tested so
 * that exact mismatch can't regress (the TokenManager tests mock `refresh`, so
 * they never exercise the real wire shape).
 */
import type { RefreshOutcome } from './token-manager.js';

export function parseRefreshResponse(status: number, body: unknown): RefreshOutcome {
  const b = (body ?? {}) as {
    session?: { accessToken?: string; refreshToken?: string; accessExpiresIn?: number };
    code?: string;
  };
  const s = b.session;
  if (status >= 200 && status < 300 && s?.accessToken && s.refreshToken) {
    return { kind: 'ok', accessToken: s.accessToken, refreshToken: s.refreshToken, accessExpiresIn: s.accessExpiresIn };
  }
  // Network failure (status 0) or a transient server error → keep the session.
  if (status === 0 || status >= 500) return { kind: 'offline' };
  // A 4xx with the reuse marker is theft (revoke the family); otherwise invalid.
  return { kind: b.code === 'token_reuse' ? 'reuse' : 'invalid' };
}
