/**
 * Teams use-cases: create org (+ owner membership + a 14-day team trial so the
 * team is usable immediately, mirroring the personal auto-trial), link/email
 * invites, accept, list/manage members. Role policy is the pure `roles.ts`; the
 * service adds the stateful guards (last-owner, already-member, invite lifecycle).
 * All failures are values (Result<…, TeamError>).
 */
import { type Result, ok, err, type Clock, type IdGen } from '@cloudstudio/cloud-kernel';
import { TeamErrors, type TeamError } from './errors.js';
import { canChangeRole, canInvite, canRemove, countWriters, isWriter } from './roles.js';
import type { Org, OrgInvite, OrgMember, OrgRole, OrgSubscription, TeamsRepo } from './types.js';

const DAY_MS = 86_400_000;
const TEAM_TRIAL_DAYS = 14;
const INVITE_TTL_DAYS = 14;
/** Writer seats granted during the trial (owner + a few teammates) before any
 *  purchase. A paid Team sets `seats` from the Stripe quantity. */
const TRIAL_SEATS = 5;

interface TokenFactory {
  issue(): Promise<{ token: string; hash: string }>;
  hashOf(token: string): Promise<string>;
}

export class TeamsService {
  constructor(
    private readonly repo: TeamsRepo,
    private readonly ids: IdGen,
    private readonly clock: Clock,
    private readonly tokens: TokenFactory,
  ) {}

  async createOrg(input: { name: string; ownerAccountId: string }): Promise<Result<Org, TeamError>> {
    const name = input.name.trim();
    if (!name || name.length > 120) return err(TeamErrors.validation('name'));
    const now = this.clock.now();
    const org: Org = {
      id: this.ids.uuid(),
      slug: this.ids.slug(12),
      name,
      ownerAccountId: input.ownerAccountId,
      kind: 'team',
      createdAtMs: now,
    };
    const owner: OrgMember = { orgId: org.id, accountId: input.ownerAccountId, role: 'owner', createdAtMs: now };
    const sub: OrgSubscription = {
      orgId: org.id,
      plan: 'team',
      status: 'trialing',
      periodEndMs: now + TEAM_TRIAL_DAYS * DAY_MS,
      seats: TRIAL_SEATS,
      trialUsed: true,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    };
    await this.repo.createOrg(org, owner, sub);
    return ok(org);
  }

  async listMyOrgs(accountId: string): Promise<{ org: Org; role: OrgRole }[]> {
    return this.repo.listForAccount(accountId);
  }

  /** The caller's membership in an org (null if not a member) — for route gating. */
  async membershipOf(orgId: string, accountId: string): Promise<OrgMember | null> {
    return this.repo.getMembership(orgId, accountId);
  }

  /** The org's subscription (null if none) — for billing checkout/portal. */
  async subscriptionOf(orgId: string): Promise<OrgSubscription | null> {
    return this.repo.getSubscription(orgId);
  }

  /** Count of current writer (non-viewer) members — the seats a purchase must cover.
   *  Viewers are free (see roles.ts countWriters). */
  async writerCount(orgId: string): Promise<number> {
    return countWriters(await this.repo.listMembers(orgId));
  }

  /** Create a one-time invite. Returns the raw token (shareable link / emailed). */
  async invite(input: { orgId: string; actorAccountId: string; role: OrgRole; email?: string }): Promise<Result<{ inviteId: string; token: string }, TeamError>> {
    if (input.role === 'owner') return err(TeamErrors.validation('role'));
    const actor = await this.repo.getMembership(input.orgId, input.actorAccountId);
    if (!actor) return err(TeamErrors.orgNotFound());
    if (!canInvite(actor.role)) return err(TeamErrors.forbidden());
    const { token, hash } = await this.tokens.issue();
    const now = this.clock.now();
    const invite: OrgInvite = {
      id: this.ids.uuid(),
      orgId: input.orgId,
      emailCanonical: input.email ? input.email.trim().toLowerCase() : null,
      role: input.role,
      tokenHash: hash,
      status: 'pending',
      invitedBy: input.actorAccountId,
      expiresAtMs: now + INVITE_TTL_DAYS * DAY_MS,
      createdAtMs: now,
    };
    await this.repo.insertInvite(invite);
    return ok({ inviteId: invite.id, token });
  }

  async accept(input: { token: string; accountId: string }): Promise<Result<{ orgId: string; role: OrgRole }, TeamError>> {
    const hash = await this.tokens.hashOf(input.token);
    const invite = await this.repo.findInviteByHash(hash);
    if (!invite) return err(TeamErrors.inviteNotFound());
    if (invite.status !== 'pending') return err(TeamErrors.inviteUsed());
    if (invite.expiresAtMs <= this.clock.now()) return err(TeamErrors.inviteExpired());
    const existing = await this.repo.getMembership(invite.orgId, input.accountId);
    if (existing) {
      await this.repo.markInviteAccepted(invite.id);
      return err(TeamErrors.alreadyMember());
    }
    // Seat enforcement: a WRITER joining must fit within the org's purchased seats
    // (viewers are free and never blocked). Lapsed/no subscription falls back to
    // the trial grant, so a fresh org can still onboard its first teammates.
    if (isWriter(invite.role)) {
      const sub = await this.repo.getSubscription(invite.orgId);
      const seats = sub ? sub.seats : 0;
      const writers = countWriters(await this.repo.listMembers(invite.orgId));
      if (writers >= seats) return err(TeamErrors.seatsExhausted(seats));
    }
    await this.repo.addMember({ orgId: invite.orgId, accountId: input.accountId, role: invite.role, createdAtMs: this.clock.now() });
    await this.repo.markInviteAccepted(invite.id);
    return ok({ orgId: invite.orgId, role: invite.role });
  }

  async listMembers(input: { orgId: string; actorAccountId: string }): Promise<Result<OrgMember[], TeamError>> {
    const actor = await this.repo.getMembership(input.orgId, input.actorAccountId);
    if (!actor) return err(TeamErrors.orgNotFound()); // hide existence from non-members
    return ok(await this.repo.listMembers(input.orgId));
  }

  async changeRole(input: { orgId: string; actorAccountId: string; targetAccountId: string; role: OrgRole }): Promise<Result<{ ok: true }, TeamError>> {
    const actor = await this.repo.getMembership(input.orgId, input.actorAccountId);
    if (!actor) return err(TeamErrors.orgNotFound());
    const target = await this.repo.getMembership(input.orgId, input.targetAccountId);
    if (!target) return err(TeamErrors.memberNotFound());
    if (!canChangeRole(actor.role, target.role, input.role)) return err(TeamErrors.forbidden());
    await this.repo.setRole(input.orgId, input.targetAccountId, input.role);
    return ok({ ok: true });
  }

  async removeMember(input: { orgId: string; actorAccountId: string; targetAccountId: string }): Promise<Result<{ ok: true }, TeamError>> {
    const actor = await this.repo.getMembership(input.orgId, input.actorAccountId);
    if (!actor) return err(TeamErrors.orgNotFound());
    const target = await this.repo.getMembership(input.orgId, input.targetAccountId);
    if (!target) return err(TeamErrors.memberNotFound());
    const isSelf = input.actorAccountId === input.targetAccountId;
    if (!canRemove(actor.role, target.role, isSelf)) return err(TeamErrors.forbidden());
    if (target.role === 'owner' && (await this.repo.countOwners(input.orgId)) <= 1) return err(TeamErrors.lastOwner());
    await this.repo.removeMember(input.orgId, input.targetAccountId);
    return ok({ ok: true });
  }
}
