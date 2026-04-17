import type { Context } from 'hono';
import { authErrorHttpStatus, authErrorMessage, type AuthError } from '../../../core/auth/domain/errors.js';

/**
 * Converts a domain AuthError into a Hono JSON response with the right HTTP
 * status + optional `WWW-Authenticate` / `Retry-After` headers.
 *
 * Centralizing this is DRY: every route that gates on auth funnels failures
 * through here, so error shape and status codes stay consistent.
 */
export function presentAuthError(c: Context, err: AuthError, issuer?: string): Response {
  const status = authErrorHttpStatus(err);
  const body = { error: err.kind, error_description: authErrorMessage(err) };

  if (status === 401) {
    // RFC 6750 §3 — point unauthenticated clients at the Protected Resource
    // Metadata endpoint so they can discover the Authorization Server.
    const params = ['Bearer realm="mcp"'];
    if (issuer) params.push(`resource_metadata="${issuer}/.well-known/oauth-protected-resource"`);
    c.header('WWW-Authenticate', params.join(', '));
  }

  if (err.kind === 'rate_limited') {
    const secs = Math.max(1, Math.ceil(err.retryAfterMs / 1000));
    c.header('Retry-After', String(secs));
  }

  return c.json(body, status as 400 | 401 | 403 | 429);
}
