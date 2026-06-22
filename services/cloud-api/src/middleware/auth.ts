/**
 * Bearer auth helper. Verifies the access token AND that its session is still
 * active in D1 — so logout / logout-all revoke access IMMEDIATELY (the stateless
 * token alone is not trusted past revocation). One small D1 read per protected
 * request; the access token still bounds the blast radius if the read is skipped.
 */
import type { Context } from 'hono';
import { asAccountId, asSessionId } from '@cloudstudio/cloud-kernel';
import type { AccessClaims } from '@cloudstudio/cloud-identity';
import type { Env } from '../env.js';
import type { IdentityBundle } from '../composition.js';

export async function requireClaims(
  c: Context<{ Bindings: Env }>,
  bundle: IdentityBundle,
): Promise<AccessClaims | null> {
  const authz = c.req.header('authorization') ?? '';
  const token = authz.startsWith('Bearer ') ? authz.slice(7) : '';
  if (!token) return null;
  const claims = await bundle.verifyAccess(token);
  if (!claims) return null;
  const active = await bundle.sessions.findActive(asSessionId(claims.sid));
  if (!active) return null;
  // Re-check account status: locking/suspending an account must take effect on the
  // NEXT request, not only when the short access token expires. (A delete cascades
  // the session away, so `findActive` already covers deletion; this covers locked.)
  const account = await bundle.accounts.findById(asAccountId(claims.sub));
  if (!account || !account.isActive) return null;
  return claims;
}

export function unauthorized(c: Context<{ Bindings: Env }>) {
  return c.json({ code: 'auth_required', message: 'Sign in required.' }, 401);
}

/** True when the access token's email is verified. Cloud WRITES gate on this
 *  (reads + the local IDE stay free). The `ev` claim refreshes on token rotation,
 *  so verifying + the next refresh (≤15 min) unlocks writes. */
export function isVerified(claims: AccessClaims): boolean {
  return claims.ev === true;
}

export function emailNotVerified(c: Context<{ Bindings: Env }>) {
  return c.json({ code: 'email_not_verified', message: 'Verify your email to publish, share, sync, or create a team.' }, 403);
}
