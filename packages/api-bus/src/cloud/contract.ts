/**
 * CodeStudio Cloud API contract — the typed wire shapes for the REMOTE backend
 * (`services/cloud-api`, a Cloudflare Worker), distinct from the in-process
 * `@mcp/api-bus` local bus. Pure types, zero runtime. Both the Electron-main
 * transport and the renderer client import these so request/response shapes are
 * defined once. (Supersedes the legacy `auth.ts`/`billing.ts` worker-license
 * stubs, which are unused.)
 */

export type CloudTier = 'free' | 'pro' | 'team' | 'enterprise';
export type AccountStatus = 'active' | 'locked' | 'deleted';

export interface CloudAccount {
  id: string;
  email: string;
  emailVerified: boolean;
  status: AccountStatus;
}

/** The renderer NEVER sees the refresh token — main strips it before returning. */
export interface CloudSessionPublic {
  sessionId: string;
  accessExpiresIn: number;
}

export interface AuthResultPublic {
  account: CloudAccount;
  session: CloudSessionPublic;
}

/** Mirrors the `Entitlements` projection in `@cloudstudio/cloud-billing`
 *  (kept in sync by hand — api-bus must not depend on the cloud packages).
 *  Limit convention: -1 = unlimited. */
export interface Entitlements {
  tier: CloudTier;
  status: 'none' | 'trialing' | 'active' | 'past_due' | 'canceled';
  periodEndMs: number | null;
  features: {
    sharing: boolean;
    sync: boolean;
    prioritySupport: boolean;
    apiDocs: boolean;
    backup: boolean;
    teamApis: boolean;
    teamMemory: boolean;
    teamTemplates: boolean;
    sso: boolean;
    auditExport: boolean;
  };
  limits: { maxActiveShares: number; maxApiDocs: number; maxSeats: number };
}

export interface CloudSessionInfo {
  id: string;
  userAgent: string | null;
  /** Real device identity (replaces the generic "node" UA in the devices list). */
  deviceName?: string | null;
  osRelease?: string | null;
  geoCountry?: string | null;
  geoCity?: string | null;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

/** Personal-sync wire types (mirror `services/cloud-api/src/sync/types.ts`). */
export type SyncKind = 'collection' | 'environment' | 'memory' | 'note' | 'project';
export interface SyncPushItem {
  kind: SyncKind;
  clientDocId: string;
  /** Last server version the client had for this doc (0 = never synced). */
  baseVersion: number;
  updatedAtMs: number;
  deleted?: boolean;
  body?: unknown;
}
export interface SyncPushResult {
  kind: SyncKind;
  clientDocId: string;
  status: 'applied' | 'noop' | 'conflict';
  version: number;
  winner?: 'incoming' | 'existing';
}
export interface SyncPullItem {
  kind: SyncKind;
  clientDocId: string;
  version: number;
  deleted: boolean;
  body: unknown | null;
}

/** Teams (organizations) wire types (mirror `services/cloud-api/src/teams`). */
export type OrgRolePublic = 'owner' | 'admin' | 'member' | 'viewer';
export interface OrgPublic {
  id: string;
  slug: string;
  name: string;
  ownerAccountId: string;
  kind: 'team' | 'personal';
  createdAtMs: number;
}
export interface OrgMemberPublic {
  orgId: string;
  accountId: string;
  role: OrgRolePublic;
  createdAtMs: number;
}

/** Per-operation input/output map. The op key is `"<namespace>.<method>"` and is
 *  resolved to an HTTP method+path by the main-process route map (never the
 *  renderer — so a compromised renderer can't aim the bearer at an arbitrary URL). */
export interface CloudContract {
  'auth.signup': { input: { email: string; password: string; passwordConfirm?: string; turnstileToken?: string }; output: AuthResultPublic };
  'auth.login': { input: { email: string; password: string; turnstileToken?: string }; output: AuthResultPublic };
  'auth.challenge2fa': { input: { challengeToken: string; code: string }; output: AuthResultPublic };
  // Browser-OAuth handoff redeem (desktop): swap a one-time handoff code from the
  // loopback for a real session. `session:'establish'` so main intercepts tokens.
  'auth.oauthRedeem': { input: { handoff: string }; output: AuthResultPublic };
  'auth.logout': { input: void; output: { ok: true } };
  'auth.logoutAll': { input: void; output: { ok: true } };
  'auth.me': { input: void; output: { account: CloudAccount } };
  'auth.sessions': { input: void; output: { sessions: CloudSessionInfo[] } };
  'auth.forgotPassword': { input: { email: string; turnstileToken?: string }; output: { ok: true } };
  'auth.resetPassword': { input: { token: string; password: string }; output: { ok: true } };
  'auth.verifyEmail': { input: { token: string }; output: { ok: true } };
  'auth.resendVerification': { input: void; output: { ok: true } };
  'twofa.enroll': { input: void; output: { otpauthUri: string; secret: string } };
  'twofa.confirm': { input: { code: string }; output: { recoveryCodes: string[] } };
  'twofa.disable': { input: { password: string; code: string }; output: { ok: true } };
  'account.entitlements': { input: void; output: Entitlements };
  'account.export': { input: void; output: Record<string, unknown> };
  'account.delete': { input: { password: string; confirm: 'DELETE' }; output: { deleted: true } };
  'billing.checkout': { input: void; output: { url: string } };
  'billing.portal': { input: void; output: { url: string } };
  'sharing.create': { input: { snapshot: unknown; visibility?: 'public' | 'unlisted'; expiresInDays?: number | null }; output: { shareId: string; slug: string; url: string } };
  'sharing.list': { input: void; output: { shares: unknown[] } };
  'sharing.revoke': { input: { id: string }; output: { revoked: true } };
  'docs.publish': { input: { title: string; description?: string; spec: unknown; visibility?: 'public' | 'unlisted'; tryItMode?: 'off' | 'local' }; output: { docId: string; slug: string; url: string; redactionCount: number; operationCount: number } };
  'docs.list': { input: void; output: { docs: unknown[]; baseUrl: string } };
  'docs.revoke': { input: { id: string }; output: { revoked: true } };
  'sync.push': { input: { documents: SyncPushItem[] }; output: { results: SyncPushResult[]; cursor: number } };
  'sync.pull': { input: { kinds?: SyncKind[]; sinceVersion: number }; output: { documents: SyncPullItem[]; cursor: number } };
  // Backup upload/download are BINARY (a gz bundle) and go through a dedicated
  // binary transport, not this JSON contract — only list/delete are JSON ops.
  'backups.list': { input: void; output: { backups: unknown[] } };
  'backups.delete': { input: { id: string }; output: { deleted: true } };
  'orgs.create': { input: { name: string }; output: { org: OrgPublic } };
  'orgs.list': { input: void; output: { orgs: { org: OrgPublic; role: OrgRolePublic }[] } };
  'orgs.invite': { input: { orgId: string; role: Exclude<OrgRolePublic, 'owner'>; email?: string }; output: { inviteId: string; token: string; url: string } };
  'orgs.acceptInvite': { input: { token: string }; output: { orgId: string; role: OrgRolePublic } };
  'orgs.members': { input: { orgId: string }; output: { members: OrgMemberPublic[] } };
  'orgs.changeRole': { input: { orgId: string; accountId: string; role: Exclude<OrgRolePublic, 'owner'> }; output: { ok: true } };
  'orgs.removeMember': { input: { orgId: string; accountId: string }; output: { ok: true } };
  // Shared team workspace (org-scoped sync of collections / env / knowledge).
  'orgs.workspacePush': { input: { orgId: string; documents: SyncPushItem[] }; output: { results: SyncPushResult[]; cursor: number } };
  'orgs.workspacePull': { input: { orgId: string; kinds?: SyncKind[]; sinceVersion: number }; output: { documents: SyncPullItem[]; cursor: number } };
  // Per-seat Teams billing (owner only). Both hand off to a Stripe-hosted URL.
  'orgs.billingCheckout': { input: { orgId: string; seats?: number }; output: { url: string } };
  'orgs.billingPortal': { input: { orgId: string }; output: { url: string } };
  // Org audit log (admin+) — Teams activity log; Enterprise builds bulk export on top.
  'orgs.audit': { input: { orgId: string }; output: { events: unknown[] } };
  'feedback.submit': { input: { kind: 'bug' | 'idea' | 'other'; message: string; appVersion?: string; os?: string }; output: { publicId: string } };
  'feedback.list': { input: void; output: { items: unknown[] } };
}

export type CloudOp = keyof CloudContract;
export type CloudInput<Op extends CloudOp> = CloudContract[Op]['input'];
export type CloudOutput<Op extends CloudOp> = CloudContract[Op]['output'];

/** What main returns to the renderer for every cloud call (never throws over IPC). */
export interface CloudFetchResult {
  ok: boolean;
  status: number;
  body: unknown;
}

/** Auth state main broadcasts to the renderer (no tokens). */
export interface CloudAuthState {
  state: 'logged_out' | 'logged_in';
  account: CloudAccount | null;
}
