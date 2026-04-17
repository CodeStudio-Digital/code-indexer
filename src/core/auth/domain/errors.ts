export type AuthError =
  | { kind: 'missing_bearer' }
  | { kind: 'invalid_token' }
  | { kind: 'expired_token' }
  | { kind: 'revoked_token' }
  | { kind: 'scope_denied'; required: string; granted: readonly string[] }
  | { kind: 'rate_limited'; retryAfterMs: number }
  | { kind: 'client_not_found'; clientId: string }
  | { kind: 'invalid_redirect_uri' }
  | { kind: 'invalid_grant' }
  | { kind: 'invalid_pkce' }
  | { kind: 'unsupported_grant_type'; grantType: string };

export function authErrorMessage(err: AuthError): string {
  switch (err.kind) {
    case 'missing_bearer': return 'Authorization bearer token is required';
    case 'invalid_token': return 'Invalid token';
    case 'expired_token': return 'Token has expired';
    case 'revoked_token': return 'Token has been revoked';
    case 'scope_denied': return `Scope '${err.required}' required; granted: [${err.granted.join(', ')}]`;
    case 'rate_limited': return `Rate limit exceeded; retry in ${err.retryAfterMs}ms`;
    case 'client_not_found': return `OAuth client '${err.clientId}' not found`;
    case 'invalid_redirect_uri': return 'redirect_uri does not match any registered URI';
    case 'invalid_grant': return 'Authorization grant is invalid';
    case 'invalid_pkce': return 'PKCE code_verifier does not match challenge';
    case 'unsupported_grant_type': return `Unsupported grant_type: ${err.grantType}`;
  }
}

export function authErrorHttpStatus(err: AuthError): number {
  switch (err.kind) {
    case 'missing_bearer':
    case 'invalid_token':
    case 'expired_token':
    case 'revoked_token':
      return 401;
    case 'scope_denied':
      return 403;
    case 'rate_limited':
      return 429;
    case 'client_not_found':
    case 'invalid_redirect_uri':
    case 'invalid_grant':
    case 'invalid_pkce':
    case 'unsupported_grant_type':
      return 400;
  }
}
