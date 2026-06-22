/**
 * Teams (organizations) routes — all Bearer-protected. Role checks live in the
 * service (membership-aware), so handlers just pass the caller as the actor.
 * Invites return a one-time token (a shareable link); the invitee accepts while
 * signed in. Mounted at /v1/orgs.
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { asAccountId, toErrorBody } from '@cloudstudio/cloud-kernel';
import type { Env } from '../env.js';
import { createIdentityBundle } from '../composition.js';
import { createTeamsBundle } from '../teams-composition.js';
import { stripeConfig } from '../billing-composition.js';
import { orgCheckout, orgPortal } from '../infra/stripe-gateway.js';
import { teamHttpStatus, TeamErrors, type TeamError } from '../teams/errors.js';
import { isAtLeast } from '../teams/roles.js';
import { resolveOrgEntitlements } from '../entitlements.js';
import { SyncService } from '../sync/service.js';
import { createOrgSyncRepo } from '../infra/d1/org-sync-repo.js';
import { SYNC_KINDS } from '../sync/types.js';
import { createD1Executor } from '../infra/d1/d1-executor.js';
import { listOrgAudit } from '../infra/audit.js';
import { sha256Hex } from '../infra/hash.js';
import { cryptoIdGen, systemClock } from '../infra/runtime.js';
import { requireClaims, unauthorized, isVerified, emailNotVerified } from '../middleware/auth.js';
import { enforceRateLimit, HOUR } from '../middleware/rate-limit.js';
import { recordAudit } from '../middleware/audit.js';

const createSchema = z.object({ name: z.string().min(1).max(120) });
const inviteSchema = z.object({ role: z.enum(['admin', 'member', 'viewer']), email: z.string().max(254).optional() });
const acceptSchema = z.object({ token: z.string().min(1).max(512) });
const roleSchema = z.object({ role: z.enum(['admin', 'member', 'viewer']) });

const wsKind = z.enum(['collection', 'environment', 'memory', 'note', 'project']);
const wsPushSchema = z.object({
  documents: z.array(z.object({
    kind: wsKind,
    clientDocId: z.string().min(1).max(128),
    baseVersion: z.number().int().nonnegative().default(0),
    updatedAtMs: z.number().int().nonnegative(),
    deleted: z.boolean().optional(),
    body: z.unknown().optional(),
  })).max(500),
});
const wsPullSchema = z.object({ kinds: z.array(wsKind).nonempty().optional(), sinceVersion: z.number().int().nonnegative().default(0) });
const checkoutSchema = z.object({ seats: z.number().int().min(1).max(1000).optional() });

/** A shared-workspace sync service scoped to one org (reuses the personal SyncService). */
function orgSyncService(env: Env, orgId: string): SyncService {
  return new SyncService(createOrgSyncRepo(createD1Executor(env.DB), orgId, cryptoIdGen, systemClock), sha256Hex);
}

function respondTeamError(c: Context<{ Bindings: Env }>, error: TeamError) {
  return c.json(toErrorBody(error), teamHttpStatus(error) as ContentfulStatusCode);
}

export function teamsRouter(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.post('/', async (c) => {
    const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ code: 'validation_failed', message: 'Invalid org payload.', details: parsed.error.flatten() }, 400);
    const claims = await requireClaims(c, createIdentityBundle(c.env));
    if (!claims) return unauthorized(c);
    if (!isVerified(claims)) return emailNotVerified(c);
    const limited = await enforceRateLimit(c, [{ key: `org:create:${claims.sub}`, limit: 20, windowMs: HOUR }]);
    if (limited) return limited;
    const r = await createTeamsBundle(c.env).service.createOrg({ name: parsed.data.name, ownerAccountId: claims.sub });
    if (!r.ok) return respondTeamError(c, r.error);
    recordAudit(c, 'org_created', 201, { accountId: claims.sub, orgId: r.value.id });
    return c.json({ org: r.value }, 201);
  });

  app.get('/', async (c) => {
    const claims = await requireClaims(c, createIdentityBundle(c.env));
    if (!claims) return unauthorized(c);
    const orgs = await createTeamsBundle(c.env).service.listMyOrgs(claims.sub);
    return c.json({ orgs }, 200);
  });

  // Accept an invite (static path — registered before the `/:id/...` params).
  app.post('/invites/accept', async (c) => {
    const parsed = acceptSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ code: 'validation_failed', message: 'Invalid token.', details: parsed.error.flatten() }, 400);
    const claims = await requireClaims(c, createIdentityBundle(c.env));
    if (!claims) return unauthorized(c);
    if (!isVerified(claims)) return emailNotVerified(c);
    const r = await createTeamsBundle(c.env).service.accept({ token: parsed.data.token, accountId: claims.sub });
    if (!r.ok) return respondTeamError(c, r.error);
    recordAudit(c, 'org_invite_accepted', 200, { accountId: claims.sub, orgId: r.value.orgId, role: r.value.role });
    return c.json(r.value, 200);
  });

  app.post('/:id/invites', async (c) => {
    const parsed = inviteSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ code: 'validation_failed', message: 'Invalid invite.', details: parsed.error.flatten() }, 400);
    const claims = await requireClaims(c, createIdentityBundle(c.env));
    if (!claims) return unauthorized(c);
    if (!isVerified(claims)) return emailNotVerified(c);
    const r = await createTeamsBundle(c.env).service.invite({ orgId: c.req.param('id'), actorAccountId: claims.sub, role: parsed.data.role, email: parsed.data.email });
    if (!r.ok) return respondTeamError(c, r.error);
    recordAudit(c, 'org_invite_created', 201, { accountId: claims.sub, orgId: c.req.param('id'), role: parsed.data.role });
    return c.json({ ...r.value, url: `${c.env.APP_BASE_URL}/join?token=${r.value.token}` }, 201);
  });

  app.get('/:id/members', async (c) => {
    const claims = await requireClaims(c, createIdentityBundle(c.env));
    if (!claims) return unauthorized(c);
    const r = await createTeamsBundle(c.env).service.listMembers({ orgId: c.req.param('id'), actorAccountId: claims.sub });
    if (!r.ok) return respondTeamError(c, r.error);
    return c.json({ members: r.value }, 200);
  });

  app.patch('/:id/members/:accountId', async (c) => {
    const parsed = roleSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ code: 'validation_failed', message: 'Invalid role.', details: parsed.error.flatten() }, 400);
    const claims = await requireClaims(c, createIdentityBundle(c.env));
    if (!claims) return unauthorized(c);
    if (!isVerified(claims)) return emailNotVerified(c); // mutating org membership is a cloud WRITE (R3)
    const r = await createTeamsBundle(c.env).service.changeRole({ orgId: c.req.param('id'), actorAccountId: claims.sub, targetAccountId: c.req.param('accountId'), role: parsed.data.role });
    if (!r.ok) return respondTeamError(c, r.error);
    recordAudit(c, 'org_role_changed', 200, { accountId: claims.sub, orgId: c.req.param('id'), target: c.req.param('accountId'), role: parsed.data.role });
    return c.json(r.value, 200);
  });

  app.delete('/:id/members/:accountId', async (c) => {
    const claims = await requireClaims(c, createIdentityBundle(c.env));
    if (!claims) return unauthorized(c);
    if (!isVerified(claims)) return emailNotVerified(c); // mutating org membership is a cloud WRITE (R3)
    const r = await createTeamsBundle(c.env).service.removeMember({ orgId: c.req.param('id'), actorAccountId: claims.sub, targetAccountId: c.req.param('accountId') });
    if (!r.ok) return respondTeamError(c, r.error);
    recordAudit(c, 'org_member_removed', 200, { accountId: claims.sub, orgId: c.req.param('id'), target: c.req.param('accountId') });
    return c.json(r.value, 200);
  });

  // ─── Per-seat billing (owner only): Stripe checkout / portal for the org ───
  app.post('/:id/billing/checkout', async (c) => {
    const parsed = checkoutSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ code: 'validation_failed', message: 'Invalid checkout payload.', details: parsed.error.flatten() }, 400);
    const identity = createIdentityBundle(c.env);
    const claims = await requireClaims(c, identity);
    if (!claims) return unauthorized(c);
    const orgId = c.req.param('id');
    const teams = createTeamsBundle(c.env).service;
    const member = await teams.membershipOf(orgId, claims.sub);
    if (!member || member.role !== 'owner') return respondTeamError(c, TeamErrors.forbidden());
    if (!c.env.STRIPE_SECRET_KEY || !c.env.STRIPE_TEAMS_PRICE_ID) return c.json({ code: 'billing_not_configured', message: 'Team billing is not configured.' }, 501);
    const account = await identity.accounts.findById(asAccountId(claims.sub));
    if (!account) return unauthorized(c);
    // Seats default to the org's current WRITER count (viewers are free — see
    // roles.ts). Audit the seat math so the bill (purchased seats vs writers) is traceable.
    const writers = await teams.writerCount(orgId);
    const seats = parsed.data.seats ?? Math.max(1, writers);
    const sub = await teams.subscriptionOf(orgId);
    const r = await orgCheckout(stripeConfig(c.env), { orgId, email: account.email, seats, stripeCustomerId: sub?.stripeCustomerId });
    recordAudit(c, 'org_billing_checkout', 200, { accountId: claims.sub, orgId, seats, writers });
    return c.json(r, 200);
  });

  app.post('/:id/billing/portal', async (c) => {
    const claims = await requireClaims(c, createIdentityBundle(c.env));
    if (!claims) return unauthorized(c);
    const orgId = c.req.param('id');
    const teams = createTeamsBundle(c.env).service;
    const member = await teams.membershipOf(orgId, claims.sub);
    if (!member || member.role !== 'owner') return respondTeamError(c, TeamErrors.forbidden());
    if (!c.env.STRIPE_SECRET_KEY) return c.json({ code: 'billing_not_configured', message: 'Team billing is not configured.' }, 501);
    const sub = await teams.subscriptionOf(orgId);
    if (!sub?.stripeCustomerId) return c.json({ code: 'no_customer', message: 'No billing customer for this org yet.' }, 409);
    const r = await orgPortal(stripeConfig(c.env), sub.stripeCustomerId);
    return c.json(r, 200);
  });

  // ─── Org audit log (admin+; the Teams activity log / Enterprise export base) ───
  app.get('/:id/audit', async (c) => {
    const claims = await requireClaims(c, createIdentityBundle(c.env));
    if (!claims) return unauthorized(c);
    const orgId = c.req.param('id');
    const member = await createTeamsBundle(c.env).service.membershipOf(orgId, claims.sub);
    if (!member) return respondTeamError(c, TeamErrors.orgNotFound());
    if (!isAtLeast(member.role, 'admin')) return respondTeamError(c, TeamErrors.forbidden());
    const ent = await resolveOrgEntitlements(c.env, orgId);
    if (!ent.features.teamApis) return c.json({ code: 'team_audit_not_entitled', message: 'Org audit requires a Team plan.' }, 402);
    const events = await listOrgAudit(createD1Executor(c.env.DB), orgId, 100);
    return c.json({ events }, 200);
  });

  // ─── Shared workspace (org-scoped sync of collections / env / knowledge) ───
  // Gated on (a) membership, (b) the ORG's own team tier (not the user's union),
  // (c) role for writes — viewers are read-only.
  app.post('/:id/workspace/push', async (c) => {
    const parsed = wsPushSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ code: 'validation_failed', message: 'Invalid push payload.', details: parsed.error.flatten() }, 400);
    const claims = await requireClaims(c, createIdentityBundle(c.env));
    if (!claims) return unauthorized(c);
    if (!isVerified(claims)) return emailNotVerified(c);
    const orgId = c.req.param('id');
    const member = await createTeamsBundle(c.env).service.membershipOf(orgId, claims.sub);
    if (!member) return respondTeamError(c, TeamErrors.orgNotFound());
    if (!isAtLeast(member.role, 'member')) return respondTeamError(c, TeamErrors.forbidden()); // viewers can't write
    const ent = await resolveOrgEntitlements(c.env, orgId);
    if (!ent.features.teamApis) return c.json({ code: 'team_workspace_not_entitled', message: 'Shared workspaces require a Team plan.' }, 402);
    const out = await orgSyncService(c.env, orgId).push(parsed.data.documents);
    return c.json(out, 200);
  });

  app.post('/:id/workspace/pull', async (c) => {
    const parsed = wsPullSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ code: 'validation_failed', message: 'Invalid pull payload.', details: parsed.error.flatten() }, 400);
    const claims = await requireClaims(c, createIdentityBundle(c.env));
    if (!claims) return unauthorized(c);
    const orgId = c.req.param('id');
    const member = await createTeamsBundle(c.env).service.membershipOf(orgId, claims.sub);
    if (!member) return respondTeamError(c, TeamErrors.orgNotFound());
    const ent = await resolveOrgEntitlements(c.env, orgId);
    if (!ent.features.teamApis) return c.json({ code: 'team_workspace_not_entitled', message: 'Shared workspaces require a Team plan.' }, 402);
    const out = await orgSyncService(c.env, orgId).pull(parsed.data.kinds ?? SYNC_KINDS, parsed.data.sinceVersion);
    return c.json(out, 200);
  });

  return app;
}
