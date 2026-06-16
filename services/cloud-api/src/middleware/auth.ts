/**
 * Bearer auth helper. Verifies the access token AND that its session is still
 * active in D1 — so logout / logout-all revoke access IMMEDIATELY (the stateless
 * token alone is not trusted past revocation). One small D1 read per protected
 * request; the access token still bounds the blast radius if the read is skipped.
 */
import type { Context } from 'hono';
import { asSessionId } from '@cloudstudio/cloud-kernel';
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
  return active ? claims : null;
}

export function unauthorized(c: Context<{ Bindings: Env }>) {
  return c.json({ code: 'auth_required', message: 'Sign in required.' }, 401);
}
