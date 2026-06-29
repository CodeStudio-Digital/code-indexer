/**
 * Portal API client — talks DIRECTLY to the cloud Worker over HTTPS with a Bearer
 * access token + a ROTATING refresh token in localStorage. Mirrors the desktop
 * TokenManager semantics: preemptive refresh before expiry, single-flight refresh,
 * one retry on 401, and forced logout on token_reuse / refresh failure (theft).
 *
 * NOTE: unlike the Electron renderer (which gets tokens stripped by main), the
 * portal receives the FULL session (accessToken + refreshToken) directly from the
 * Worker — that's the whole point of a direct-fetch SPA.
 */
import type { Entitlements, CloudSessionInfo, OrgPublic, OrgMemberPublic, OrgRolePublic, SyncPullItem } from '@mcp/api-bus';

const API_BASE = (((import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_CLOUD_API_URL ?? '') as string).replace(/\/$/, '');
const SKEW_MS = 30_000;

const K = {
  access: 'cs_portal_access',
  refresh: 'cs_portal_refresh',
  exp: 'cs_portal_access_exp',
  session: 'cs_portal_session',
} as const;

export interface Session {
  sessionId: string;
  accessToken: string;
  accessExpiresIn: number;
  refreshToken: string;
  refreshExpiresIn: number;
}
export interface Account {
  id: string;
  email: string;
  emailVerified: boolean;
  status: 'active' | 'locked' | 'deleted';
}
export interface AuthResult {
  account: Account;
  session: Session;
}

export const tokens = {
  get access(): string | null {
    return localStorage.getItem(K.access);
  },
  get refresh(): string | null {
    return localStorage.getItem(K.refresh);
  },
  get expAt(): number {
    return Number(localStorage.getItem(K.exp) ?? 0);
  },
  get sessionId(): string | null {
    return localStorage.getItem(K.session);
  },
  get isLoggedIn(): boolean {
    return !!localStorage.getItem(K.refresh);
  },
  set(s: Session): void {
    localStorage.setItem(K.access, s.accessToken);
    localStorage.setItem(K.refresh, s.refreshToken);
    localStorage.setItem(K.exp, String(Date.now() + s.accessExpiresIn * 1000));
    localStorage.setItem(K.session, s.sessionId);
  },
  clear(): void {
    for (const k of Object.values(K)) localStorage.removeItem(k);
  },
};

export type ApiErrorKind =
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

const CODE_KIND: Record<string, ApiErrorKind> = {
  validation_failed: 'invalid_input',
  password_mismatch: 'invalid_input',
  email_invalid: 'invalid_input',
  password_too_weak: 'invalid_input',
  invalid_credentials: 'auth_required',
  auth_required: 'auth_required',
  account_deleted: 'auth_required',
  account_locked: 'auth_required',
  email_not_verified: 'email_unverified',
  twofa_required: 'twofa_required',
  twofa_invalid: 'invalid_input',
  token_reuse: 'forced_logout',
  refresh_invalid: 'forced_logout',
  refresh_expired: 'forced_logout',
  rate_limited: 'rate_limited',
  turnstile_failed: 'bot_check',
  handoff_invalid: 'auth_required',
};

function statusKind(status: number): ApiErrorKind {
  if (status === 0) return 'offline';
  if (status === 400) return 'invalid_input';
  if (status === 401 || status === 423) return 'auth_required';
  if (status === 402) return 'entitlement';
  if (status === 403) return 'auth_required';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 413) return 'too_large';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  return 'unknown';
}

export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function mapError(status: number, body: unknown): ApiError {
  const b = (body && typeof body === 'object' ? body : {}) as { code?: string; message?: string; details?: unknown };
  const kind = (b.code && CODE_KIND[b.code]) || statusKind(status);
  return new ApiError(kind, status, b.message || defaultMessage(kind), b.code, b.details);
}

function defaultMessage(kind: ApiErrorKind): string {
  switch (kind) {
    case 'offline':
      return 'You appear to be offline.';
    case 'auth_required':
      return 'Please sign in again.';
    case 'forced_logout':
      return 'Your session was revoked for security. Sign in again.';
    case 'rate_limited':
      return 'Too many attempts. Please wait and try again.';
    case 'entitlement':
      return 'This feature requires an active plan.';
    case 'email_unverified':
      return 'Verify your email to use cloud features.';
    case 'bot_check':
      return 'Bot verification failed. Please retry.';
    case 'server_error':
      return 'Something went wrong. Please try again.';
    default:
      return 'Request failed.';
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

let refreshInFlight: Promise<boolean> | null = null;

async function doRefresh(): Promise<boolean> {
  const rt = tokens.refresh;
  if (!rt) return false;
  try {
    const res = await fetch(`${API_BASE}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: rt }),
    });
    if (!res.ok) {
      // 401/409 ⇒ dead/revoked family (theft) → clear. 5xx/network handled by catch.
      if (res.status === 401 || res.status === 409 || res.status === 400) tokens.clear();
      return false;
    }
    const body = safeJson(await res.text()) as { session?: Session };
    if (!body.session?.accessToken || !body.session.refreshToken) {
      // A 200 without a full session is a dead/garbled response — never keep reusing
      // the (possibly already-rotated) refresh token; force a clean re-login.
      tokens.clear();
      return false;
    }
    tokens.set(body.session);
    return true;
  } catch {
    return false; // transient network — keep tokens, fail this attempt
  }
}

function refreshOnce(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = doRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

async function ensureFresh(): Promise<void> {
  if (!tokens.refresh) return;
  if (Date.now() < tokens.expAt - SKEW_MS) return;
  await refreshOnce();
}

interface RequestOpts {
  method?: 'GET' | 'POST' | 'DELETE' | 'PATCH';
  body?: unknown;
  /** Default true. When false, no token attached / no refresh. */
  auth?: boolean;
}

async function request<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const auth = opts.auth !== false;
  if (auth) await ensureFresh();
  const method = opts.method ?? (opts.body !== undefined ? 'POST' : 'GET');

  const send = async (): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const at = tokens.access;
    if (auth && at) headers.authorization = `Bearer ${at}`;
    try {
      return await fetch(`${API_BASE}${path}`, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch {
      // Network failure → synthesize a 0 so the caller maps it to 'offline'.
      return new Response(JSON.stringify({ code: 'offline', message: 'Network error.' }), { status: 0 as number });
    }
  };

  let res = await send();
  if (res.status === 401 && auth && tokens.refresh) {
    if (await refreshOnce()) res = await send();
  }
  const data = safeJson(await res.text().catch(() => ''));
  if (!res.ok) {
    const err = mapError(res.status, data);
    if (err.kind === 'auth_required' || err.kind === 'forced_logout') tokens.clear();
    throw err;
  }
  return data as T;
}

// ── Typed endpoints ────────────────────────────────────────────────────────
export type ProviderId = 'google' | 'github' | 'microsoft';

export const api = {
  // auth (token-establishing — store the returned session)
  async login(email: string, password: string, turnstileToken?: string): Promise<AuthResult> {
    const r = await request<AuthResult>('/v1/auth/login', { body: { email, password, turnstileToken }, auth: false });
    tokens.set(r.session);
    return r;
  },
  async signup(email: string, password: string, passwordConfirm: string, turnstileToken?: string): Promise<AuthResult> {
    const r = await request<AuthResult>('/v1/auth/signup', { body: { email, password, passwordConfirm, turnstileToken }, auth: false });
    tokens.set(r.session);
    return r;
  },
  async challenge2fa(challengeToken: string, code: string): Promise<AuthResult> {
    const r = await request<AuthResult>('/v1/auth/2fa/challenge', { body: { challengeToken, code }, auth: false });
    tokens.set(r.session);
    return r;
  },
  async oauthRedeem(handoff: string): Promise<AuthResult> {
    const r = await request<AuthResult>('/v1/auth/oauth/redeem', { body: { handoff }, auth: false });
    tokens.set(r.session);
    return r;
  },
  oauthStartUrl(provider: ProviderId): string {
    return `${API_BASE}/v1/auth/oauth/${provider}/start?flow=portal`;
  },
  // Device login: mint a one-time handoff for the desktop loopback from this
  // (already authenticated) browser session. Used by the /device bridge page.
  createHandoff: () => request<{ handoff: string }>('/v1/auth/handoff', { method: 'POST' }),

  // sso (per-org OIDC, Enterprise)
  ssoStartUrl: (orgId: string): string => `${API_BASE}/v1/auth/sso/${encodeURIComponent(orgId)}/start?flow=portal`,
  ssoCallbackUrl: (): string => `${API_BASE}/v1/auth/sso/callback`,
  ssoGetConfig: (orgId: string) =>
    request<
      { configured: false } | { configured: true; issuer: string; clientId: string; allowedDomains: string[]; enabled: boolean }
    >(`/v1/auth/sso/${encodeURIComponent(orgId)}/config`),
  ssoSetConfig: (
    orgId: string,
    body: { issuer: string; clientId: string; clientSecret: string; allowedDomains: string[]; enabled: boolean },
  ) => request<{ ok: true }>(`/v1/auth/sso/${encodeURIComponent(orgId)}/config`, { body }),

  // account
  me: () => request<{ account: Account }>('/v1/auth/me'),
  sessions: () => request<{ sessions: CloudSessionInfo[] }>('/v1/auth/sessions'),
  logout: () => request<{ ok: true }>('/v1/auth/logout', { method: 'POST' }),
  logoutAll: () => request<{ ok: true }>('/v1/auth/logout-all', { method: 'POST' }),
  resendVerification: () => request<{ ok: true; alreadyVerified?: boolean }>('/v1/auth/resend-verification', { method: 'POST' }),
  forgotPassword: (email: string) => request<{ ok: true }>('/v1/auth/request-password-reset', { body: { email }, auth: false }),
  resetPassword: (token: string, password: string) =>
    request<{ ok: true }>('/v1/auth/reset-password', { body: { token, password }, auth: false }),
  verifyEmail: (token: string) => request<{ ok: true }>('/v1/auth/verify-email', { body: { token }, auth: false }),
  exportAccount: () => request<Record<string, unknown>>('/v1/account/export'),
  deleteAccount: (password: string) =>
    request<{ deleted: true }>('/v1/account', { method: 'DELETE', body: { password, confirm: 'DELETE' } }),

  // 2FA
  twofaEnroll: () => request<{ otpauthUri: string; secret: string }>('/v1/auth/2fa/enroll', { method: 'POST' }),
  twofaConfirm: (code: string) => request<{ recoveryCodes: string[] }>('/v1/auth/2fa/confirm', { body: { code } }),
  twofaDisable: (password: string, code: string) => request<{ ok: true }>('/v1/auth/2fa/disable', { body: { password, code } }),

  // account
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true }>('/v1/account/password', { body: { currentPassword, newPassword } }),

  // billing
  entitlements: () => request<Entitlements>('/v1/billing/entitlements'),
  billingCheckout: () => request<{ url: string }>('/v1/billing/checkout', { method: 'POST' }),
  billingPortal: () => request<{ url: string }>('/v1/billing/portal', { method: 'POST' }),
  // Self-heal a missed checkout webhook (called by the post-purchase success page).
  billingSync: () => request<{ applied: boolean }>('/v1/billing/sync', { method: 'POST' }),

  // docs
  docsList: () => request<{ docs: HostedDoc[]; baseUrl: string }>('/v1/docs'),

  // projects (cloud library)
  pullProjects: (sinceVersion = 0) =>
    request<{ documents: SyncPullItem[]; cursor: number }>('/v1/sync/pull', { body: { kinds: ['project'], sinceVersion } }),

  // teams
  orgsList: () => request<{ orgs: { org: OrgPublic; role: OrgRolePublic }[] }>('/v1/orgs'),
  orgMembers: (orgId: string) => request<{ members: OrgMemberPublic[] }>(`/v1/orgs/${encodeURIComponent(orgId)}/members`),
  orgInvite: (orgId: string, role: Exclude<OrgRolePublic, 'owner'>, email?: string) =>
    request<{ inviteId: string; token: string; url: string }>(`/v1/orgs/${encodeURIComponent(orgId)}/invites`, { body: { role, email } }),
  orgAcceptInvite: (token: string) => request<{ orgId: string; role: OrgRolePublic }>('/v1/orgs/invites/accept', { body: { token } }),
  orgChangeRole: (orgId: string, accountId: string, role: Exclude<OrgRolePublic, 'owner'>) =>
    request<{ ok: true }>(`/v1/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(accountId)}`, { method: 'PATCH', body: { role } }),
  orgRemoveMember: (orgId: string, accountId: string) =>
    request<{ ok: true }>(`/v1/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(accountId)}`, { method: 'DELETE' }),
  orgCreate: (name: string) => request<{ org: OrgPublic }>('/v1/orgs', { body: { name } }),
  orgBillingCheckout: (orgId: string, seats?: number) =>
    request<{ url: string }>(`/v1/orgs/${encodeURIComponent(orgId)}/billing/checkout`, { body: { seats } }),
  orgBillingPortal: (orgId: string) => request<{ url: string }>(`/v1/orgs/${encodeURIComponent(orgId)}/billing/portal`, { method: 'POST' }),

  // SSH vault (zero-knowledge): the portal manages key distribution metadata only — it
  // never sees plaintext or vault keys. `vaultMembers` = who published a key (grant-ready);
  // `vaultRotate` invalidates all grants so an admin can re-share after a membership change.
  vaultMembers: (orgId: string) =>
    request<{ members: { accountId: string; publicSpki: string }[] }>(`/v1/orgs/${encodeURIComponent(orgId)}/vault/members`),
  vaultRotate: (orgId: string, projectWorkspaceId: string) =>
    request<{ ok: true }>(`/v1/orgs/${encodeURIComponent(orgId)}/vault/rotate`, { body: { projectWorkspaceId } }),
};

export interface HostedDoc {
  id: string;
  slug: string;
  title: string;
  description?: string;
  visibility: 'public' | 'unlisted';
  status?: string;
  tryItMode?: 'off' | 'local';
  operationCount?: number;
  createdAtMs?: number;
}

/** A cloud project pointer (the `body` of a kind:'project' sync doc). */
export interface ProjectPointer {
  name: string;
  gitRemote?: string;
  description?: string;
  defaultBranch?: string;
  workspaceId?: string;
}
