/**
 * Teams (organizations) domain types + ports. An org is the "team" in v1: it has
 * members with roles, link/email invites, and a per-org subscription. Pure (no
 * I/O); the D1 adapter implements TeamsRepo. The org subscription mirrors the
 * shape `deriveEntitlements` reads (plan/status/periodEndMs) so the entitlements
 * union can project it without a bespoke mapper.
 */
import type { PlanId, SubStatus } from '@cloudstudio/cloud-billing';

export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer';

export interface Org {
  id: string;
  slug: string;
  name: string;
  ownerAccountId: string;
  kind: 'team' | 'personal';
  createdAtMs: number;
}

export interface OrgMember {
  orgId: string;
  accountId: string;
  role: OrgRole;
  createdAtMs: number;
}

export interface OrgInvite {
  id: string;
  orgId: string;
  emailCanonical: string | null;
  role: OrgRole;
  tokenHash: string;
  status: 'pending' | 'accepted' | 'revoked';
  invitedBy: string;
  expiresAtMs: number;
  createdAtMs: number;
}

export interface OrgSubscription {
  orgId: string;
  plan: PlanId;
  status: SubStatus;
  periodEndMs: number | null;
  seats: number;
  trialUsed: boolean;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
}

export interface TeamsRepo {
  /** Atomic: insert org + owner membership + (optional) org subscription. */
  createOrg(org: Org, owner: OrgMember, sub: OrgSubscription | null): Promise<void>;
  getOrg(orgId: string): Promise<Org | null>;
  listForAccount(accountId: string): Promise<{ org: Org; role: OrgRole }[]>;
  getMembership(orgId: string, accountId: string): Promise<OrgMember | null>;
  listMembers(orgId: string): Promise<OrgMember[]>;
  countOwners(orgId: string): Promise<number>;
  addMember(member: OrgMember): Promise<void>;
  setRole(orgId: string, accountId: string, role: OrgRole): Promise<void>;
  removeMember(orgId: string, accountId: string): Promise<void>;
  insertInvite(invite: OrgInvite): Promise<void>;
  findInviteByHash(tokenHash: string): Promise<OrgInvite | null>;
  markInviteAccepted(id: string): Promise<void>;
  getSubscription(orgId: string): Promise<OrgSubscription | null>;
  /** Upsert the org subscription (the per-seat Stripe webhook projection). */
  upsertSubscription(sub: OrgSubscription): Promise<void>;
  /** Org subscriptions for every org the account belongs to (entitlements union). */
  listSubsForAccount(accountId: string): Promise<OrgSubscription[]>;
}
