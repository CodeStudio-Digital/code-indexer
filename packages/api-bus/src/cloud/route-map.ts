/**
 * Op → HTTP route resolution for the CodeStudio Cloud API. Shared by the Electron
 * main transport (the secure, primary path) and the dev-only renderer fallback
 * bridge. `auth` decides whether an access token is attached; `session` marks the
 * ops that establish/clear a login (the caller intercepts their tokens and never
 * forwards them to the renderer).
 */
import type { CloudOp } from './contract.js';

export type AuthMode = 'required' | 'optional' | 'none';
export type SessionEffect = 'establish' | 'clear' | null;

export interface CloudRoute {
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH';
  path: (input: Record<string, unknown>) => string;
  auth: AuthMode;
  session: SessionEffect;
}

const p = (s: string) => () => s;

export const ROUTE_MAP: Record<CloudOp, CloudRoute> = {
  'auth.signup': { method: 'POST', path: p('/v1/auth/signup'), auth: 'none', session: 'establish' },
  'auth.login': { method: 'POST', path: p('/v1/auth/login'), auth: 'none', session: 'establish' },
  'auth.challenge2fa': { method: 'POST', path: p('/v1/auth/2fa/challenge'), auth: 'none', session: 'establish' },
  'auth.oauthRedeem': { method: 'POST', path: p('/v1/auth/oauth/redeem'), auth: 'none', session: 'establish' },
  'auth.logout': { method: 'POST', path: p('/v1/auth/logout'), auth: 'required', session: 'clear' },
  'auth.logoutAll': { method: 'POST', path: p('/v1/auth/logout-all'), auth: 'required', session: 'clear' },
  'auth.me': { method: 'GET', path: p('/v1/auth/me'), auth: 'required', session: null },
  'auth.sessions': { method: 'GET', path: p('/v1/auth/sessions'), auth: 'required', session: null },
  'auth.forgotPassword': { method: 'POST', path: p('/v1/auth/request-password-reset'), auth: 'none', session: null },
  'auth.resetPassword': { method: 'POST', path: p('/v1/auth/reset-password'), auth: 'none', session: null },
  'auth.verifyEmail': { method: 'POST', path: p('/v1/auth/verify-email'), auth: 'none', session: null },
  'auth.resendVerification': { method: 'POST', path: p('/v1/auth/resend-verification'), auth: 'required', session: null },
  'twofa.enroll': { method: 'POST', path: p('/v1/auth/2fa/enroll'), auth: 'required', session: null },
  'twofa.confirm': { method: 'POST', path: p('/v1/auth/2fa/confirm'), auth: 'required', session: null },
  'twofa.disable': { method: 'POST', path: p('/v1/auth/2fa/disable'), auth: 'required', session: null },
  'account.entitlements': { method: 'GET', path: p('/v1/billing/entitlements'), auth: 'required', session: null },
  'account.changePassword': { method: 'POST', path: p('/v1/account/password'), auth: 'required', session: null },
  'account.export': { method: 'GET', path: p('/v1/account/export'), auth: 'required', session: null },
  'account.delete': { method: 'DELETE', path: p('/v1/account'), auth: 'required', session: 'clear' },
  'billing.checkout': { method: 'POST', path: p('/v1/billing/checkout'), auth: 'required', session: null },
  'billing.portal': { method: 'POST', path: p('/v1/billing/portal'), auth: 'required', session: null },
  'billing.sync': { method: 'POST', path: p('/v1/billing/sync'), auth: 'required', session: null },
  'sharing.create': { method: 'POST', path: p('/v1/share'), auth: 'required', session: null },
  'sharing.list': { method: 'GET', path: p('/v1/share'), auth: 'required', session: null },
  'sharing.revoke': { method: 'DELETE', path: (i) => `/v1/share/${encodeURIComponent(String(i.id))}`, auth: 'required', session: null },
  'docs.publish': { method: 'POST', path: p('/v1/docs'), auth: 'required', session: null },
  'docs.list': { method: 'GET', path: p('/v1/docs'), auth: 'required', session: null },
  'docs.revoke': { method: 'DELETE', path: (i) => `/v1/docs/${encodeURIComponent(String(i.id))}`, auth: 'required', session: null },
  'sync.push': { method: 'POST', path: p('/v1/sync/push'), auth: 'required', session: null },
  'sync.pull': { method: 'POST', path: p('/v1/sync/pull'), auth: 'required', session: null },
  'backups.list': { method: 'GET', path: p('/v1/backups'), auth: 'required', session: null },
  'backups.delete': { method: 'DELETE', path: (i) => `/v1/backups/${encodeURIComponent(String(i.id))}`, auth: 'required', session: null },
  'orgs.create': { method: 'POST', path: p('/v1/orgs'), auth: 'required', session: null },
  'orgs.list': { method: 'GET', path: p('/v1/orgs'), auth: 'required', session: null },
  'orgs.invite': { method: 'POST', path: (i) => `/v1/orgs/${encodeURIComponent(String(i.orgId))}/invites`, auth: 'required', session: null },
  'orgs.acceptInvite': { method: 'POST', path: p('/v1/orgs/invites/accept'), auth: 'required', session: null },
  'orgs.members': { method: 'GET', path: (i) => `/v1/orgs/${encodeURIComponent(String(i.orgId))}/members`, auth: 'required', session: null },
  'orgs.changeRole': { method: 'PATCH', path: (i) => `/v1/orgs/${encodeURIComponent(String(i.orgId))}/members/${encodeURIComponent(String(i.accountId))}`, auth: 'required', session: null },
  'orgs.removeMember': { method: 'DELETE', path: (i) => `/v1/orgs/${encodeURIComponent(String(i.orgId))}/members/${encodeURIComponent(String(i.accountId))}`, auth: 'required', session: null },
  'orgs.workspacePush': { method: 'POST', path: (i) => `/v1/orgs/${encodeURIComponent(String(i.orgId))}/workspace/push`, auth: 'required', session: null },
  'orgs.workspacePull': { method: 'POST', path: (i) => `/v1/orgs/${encodeURIComponent(String(i.orgId))}/workspace/pull`, auth: 'required', session: null },
  'account.vaultKeyPut': { method: 'POST', path: p('/v1/account/vault/key'), auth: 'required', session: null },
  'orgs.vaultMembers': { method: 'GET', path: (i) => `/v1/orgs/${encodeURIComponent(String(i.orgId))}/vault/members`, auth: 'required', session: null },
  'orgs.vaultGrantsPut': { method: 'POST', path: (i) => `/v1/orgs/${encodeURIComponent(String(i.orgId))}/vault/grants`, auth: 'required', session: null },
  'orgs.vaultGrantsMine': { method: 'GET', path: (i) => `/v1/orgs/${encodeURIComponent(String(i.orgId))}/vault/grants/me?projectWorkspaceId=${encodeURIComponent(String(i.projectWorkspaceId))}`, auth: 'required', session: null },
  'orgs.vaultRotate': { method: 'POST', path: (i) => `/v1/orgs/${encodeURIComponent(String(i.orgId))}/vault/rotate`, auth: 'required', session: null },
  'orgs.vaultPush': { method: 'POST', path: (i) => `/v1/orgs/${encodeURIComponent(String(i.orgId))}/vault/push`, auth: 'required', session: null },
  'orgs.vaultPull': { method: 'POST', path: (i) => `/v1/orgs/${encodeURIComponent(String(i.orgId))}/vault/pull`, auth: 'required', session: null },
  'orgs.billingCheckout': { method: 'POST', path: (i) => `/v1/orgs/${encodeURIComponent(String(i.orgId))}/billing/checkout`, auth: 'required', session: null },
  'orgs.billingPortal': { method: 'POST', path: (i) => `/v1/orgs/${encodeURIComponent(String(i.orgId))}/billing/portal`, auth: 'required', session: null },
  'orgs.audit': { method: 'GET', path: (i) => `/v1/orgs/${encodeURIComponent(String(i.orgId))}/audit`, auth: 'required', session: null },
  'feedback.submit': { method: 'POST', path: p('/v1/feedback'), auth: 'optional', session: null },
  'feedback.list': { method: 'GET', path: p('/v1/feedback'), auth: 'required', session: null },
  'github.installations': { method: 'GET', path: p('/v1/github/installations'), auth: 'required', session: null },
  'github.connect': { method: 'POST', path: p('/v1/github/connect'), auth: 'required', session: null },
  'github.repository': {
    method: 'GET',
    path: (i) => `/v1/github/repository?host=${encodeURIComponent(String(i.host))}&owner=${encodeURIComponent(String(i.owner))}&repo=${encodeURIComponent(String(i.repo))}`,
    auth: 'required',
    session: null,
  },
  'github.disconnect': {
    method: 'DELETE',
    path: (i) => `/v1/github/installations/${encodeURIComponent(String(i.installationId))}`,
    auth: 'required',
    session: null,
  },
  'github.createGrant': { method: 'POST', path: p('/v1/github/grants'), auth: 'required', session: null },
  'github.createPullRequest': { method: 'POST', path: p('/v1/github/pull-requests'), auth: 'required', session: null },
};
