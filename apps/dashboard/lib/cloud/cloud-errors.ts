/**
 * Renderer-side mirror of the cloud API's error model. `mapCloudError` turns the
 * server's `{ code, message, details }` + HTTP status into a typed `CloudError`
 * with a UI-facing `kind`, so screens branch on intent (re-login, upsell, bot
 * check, …) rather than raw codes. Pure — unit-tested for exhaustiveness.
 */
export type CloudErrorKind =
  | 'invalid_input'
  | 'auth_required'
  | 'email_unverified'
  | 'twofa_required'
  | 'entitlement'
  | 'forced_logout'
  | 'rate_limited'
  | 'bot_check'
  | 'not_found'
  | 'conflict'
  | 'too_large'
  | 'offline'
  | 'server_error'
  | 'unknown';

export class CloudError extends Error {
  constructor(
    readonly kind: CloudErrorKind,
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'CloudError';
  }
}

interface ServerErrorBody {
  code?: string;
  message?: string;
  details?: unknown;
}

/** A small subset of codes routes to a specific UI intent regardless of status. */
const CODE_KIND: Record<string, CloudErrorKind> = {
  validation_failed: 'invalid_input',
  invalid_credentials: 'auth_required',
  auth_required: 'auth_required',
  email_not_verified: 'email_unverified',
  email_unverified: 'email_unverified',
  twofa_required: 'twofa_required',
  token_reuse: 'forced_logout',
  rate_limited: 'rate_limited',
  feedback_rate_limited: 'rate_limited',
  turnstile_failed: 'bot_check',
  human_verification_required: 'bot_check',
  human_verification_failed: 'bot_check',
  sharing_not_entitled: 'entitlement',
  share_quota_exceeded: 'entitlement',
  billing_not_configured: 'entitlement',
  server_misconfigured: 'server_error',
};

const STATUS_KIND = (status: number): CloudErrorKind => {
  if (status === 0) return 'offline';
  if (status === 400) return 'invalid_input';
  if (status === 401 || status === 423) return 'auth_required';
  if (status === 402) return 'entitlement';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 413) return 'too_large';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  return 'unknown';
};

export function mapCloudError(status: number, body: unknown): CloudError {
  const b = (body && typeof body === 'object' ? body : {}) as ServerErrorBody;
  const kind = (b.code && CODE_KIND[b.code]) || STATUS_KIND(status);
  const message = b.message || defaultMessage(kind);
  return new CloudError(kind, status, message, b.code, b.details);
}

function defaultMessage(kind: CloudErrorKind): string {
  switch (kind) {
    case 'offline': return 'You appear to be offline.';
    case 'auth_required': return 'Please sign in again.';
    case 'forced_logout': return 'Your session was revoked for security. Sign in again.';
    case 'rate_limited': return 'Too many attempts. Please wait and try again.';
    case 'entitlement': return 'This feature requires an active subscription.';
    case 'email_unverified': return 'Verify your email to use cloud features (check your inbox).';
    case 'bot_check': return 'Bot verification failed. Please retry.';
    case 'server_error': return 'Something went wrong. Please try again.';
    default: return 'Request failed.';
  }
}
