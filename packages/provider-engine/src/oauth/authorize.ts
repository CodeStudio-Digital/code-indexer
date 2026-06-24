import type { AuthDescriptor } from '@mcp/provider-sdk';

/**
 * Pick the authorize endpoint. `authorizeUrlByScope` (claude-code: claude.ai
 * inference vs console host) wins when one of its `whenScope`s is requested,
 * else falls back to `authorizeUrl`.
 */
export function resolveAuthorizeUrl(auth: AuthDescriptor, scopes: string[]): string | undefined {
  const byScope = auth.authorizeUrlByScope;
  if (byScope && byScope.length > 0) {
    return (byScope.find((x) => scopes.includes(x.whenScope)) ?? byScope[0]).url;
  }
  return auth.authorizeUrl;
}

export interface AuthorizeUrlOpts {
  redirectUri: string;
  state: string;
  codeChallenge: string;
  /** Override the spec scopes (e.g. claude-code inference-only). */
  scopes?: string[];
}

/**
 * Build the RFC 6749 authorization-code authorize URL from `spec.auth`. The
 * provider-specific `authorizeParams` (the 3 Codex params, google's
 * access_type/prompt, claude-code's `code=true`) are appended VERBATIM — they
 * are spec DATA, not code. This reproduces each provider's hand-written URL.
 */
export function buildAuthorizeUrl(auth: AuthDescriptor, opts: AuthorizeUrlOpts): string {
  const scopes = opts.scopes ?? auth.scopes ?? [];
  const base = resolveAuthorizeUrl(auth, scopes);
  if (!base) throw new Error('provider-engine/oauth: spec.auth has no authorize URL');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: auth.clientId ?? '',
    redirect_uri: opts.redirectUri,
    scope: scopes.join(' '),
    state: opts.state,
    code_challenge: opts.codeChallenge,
    code_challenge_method: 'S256',
    ...(auth.authorizeParams ?? {}),
  });
  return `${base}?${params.toString()}`;
}

/** `http://localhost:<port><path>` redirect URI from `spec.auth.redirect`. */
export function loopbackRedirectUri(auth: AuthDescriptor): string {
  const port = auth.redirect?.port ?? 0;
  const path = auth.redirect?.path ?? '/callback';
  return `http://localhost:${port}${path}`;
}
