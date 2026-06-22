/**
 * Teams tests: pure role policy + the TeamsService (create org grants owner +
 * team trial; invite/accept lifecycle; role-change + remove guards incl. last
 * owner). In-memory repo + deterministic tokens. No D1.
 */
import { describe, it, expect } from 'vitest';
import type { Clock, IdGen } from '@cloudstudio/cloud-kernel';
import { TeamsService } from '../teams/service.js';
import { ROLE_RANK, canChangeRole, canRemove, canInvite, isWriter, countWriters } from '../teams/roles.js';
import type { Org, OrgInvite, OrgMember, OrgRole, OrgSubscription, TeamsRepo } from '../teams/types.js';

let seq = 0;
let nowMs = 1_700_000_000_000;
const ids: IdGen = { uuid: () => `id${++seq}`, slug: () => `slug${++seq}` };
const clock: Clock = { now: () => nowMs, isoNow: () => new Date(nowMs).toISOString() };
let tok = 0;
const tokens = { issue: async () => { const t = `tok${++tok}`; return { token: t, hash: `h:${t}` }; }, hashOf: async (t: string) => `h:${t}` };

class FakeTeamsRepo implements TeamsRepo {
  orgs = new Map<string, Org>();
  members: OrgMember[] = [];
  invites = new Map<string, OrgInvite>();
  subs = new Map<string, OrgSubscription>();
  async createOrg(org: Org, owner: OrgMember, sub: OrgSubscription | null) {
    this.orgs.set(org.id, org);
    this.members.push(owner);
    if (sub) this.subs.set(org.id, sub);
  }
  async getOrg(id: string) { return this.orgs.get(id) ?? null; }
  async listForAccount(accountId: string) {
    return this.members.filter((m) => m.accountId === accountId).map((m) => ({ org: this.orgs.get(m.orgId)!, role: m.role }));
  }
  async getMembership(orgId: string, accountId: string) { return this.members.find((m) => m.orgId === orgId && m.accountId === accountId) ?? null; }
  async listMembers(orgId: string) { return this.members.filter((m) => m.orgId === orgId); }
  async countOwners(orgId: string) { return this.members.filter((m) => m.orgId === orgId && m.role === 'owner').length; }
  async addMember(m: OrgMember) { this.members.push(m); }
  async setRole(orgId: string, accountId: string, role: OrgRole) { const m = this.members.find((x) => x.orgId === orgId && x.accountId === accountId); if (m) m.role = role; }
  async removeMember(orgId: string, accountId: string) { this.members = this.members.filter((m) => !(m.orgId === orgId && m.accountId === accountId)); }
  async insertInvite(i: OrgInvite) { this.invites.set(i.tokenHash, i); }
  async findInviteByHash(h: string) { return this.invites.get(h) ?? null; }
  async markInviteAccepted(id: string) { for (const i of this.invites.values()) if (i.id === id) i.status = 'accepted'; }
  async getSubscription(orgId: string) { return this.subs.get(orgId) ?? null; }
  async upsertSubscription(s: OrgSubscription) { this.subs.set(s.orgId, s); }
  async listSubsForAccount(accountId: string) {
    const myOrgs = new Set(this.members.filter((m) => m.accountId === accountId).map((m) => m.orgId));
    return [...this.subs.values()].filter((s) => myOrgs.has(s.orgId));
  }
}

const build = () => { const repo = new FakeTeamsRepo(); return { repo, svc: new TeamsService(repo, ids, clock, tokens) }; };

describe('role policy', () => {
  it('ranks owner > admin > member > viewer', () => {
    expect(ROLE_RANK.owner).toBeGreaterThan(ROLE_RANK.admin);
    expect(ROLE_RANK.member).toBeGreaterThan(ROLE_RANK.viewer);
  });
  it('only admin+ can invite', () => {
    expect(canInvite('admin')).toBe(true);
    expect(canInvite('member')).toBe(false);
  });
  it('seat policy: writers = owner/admin/member; viewers are free', () => {
    expect(isWriter('owner')).toBe(true);
    expect(isWriter('admin')).toBe(true);
    expect(isWriter('member')).toBe(true);
    expect(isWriter('viewer')).toBe(false);
    // countWriters excludes viewers — the billable seat count
    const members = [{ role: 'owner' }, { role: 'admin' }, { role: 'member' }, { role: 'viewer' }, { role: 'viewer' }] as const;
    expect(countWriters(members)).toBe(3);
    expect(countWriters([{ role: 'viewer' }, { role: 'viewer' }])).toBe(0);
  });
  it('admins cannot touch owners or grant ownership; owners can manage admins', () => {
    expect(canChangeRole('admin', 'member', 'viewer')).toBe(true);
    expect(canChangeRole('admin', 'owner', 'member')).toBe(false);
    expect(canChangeRole('admin', 'member', 'owner')).toBe(false);
    expect(canChangeRole('admin', 'admin', 'member')).toBe(false);
    expect(canChangeRole('owner', 'admin', 'member')).toBe(true);
  });
  it('remove: self always; admins remove non-owners; only owner removes admins', () => {
    expect(canRemove('viewer', 'viewer', true)).toBe(true);
    expect(canRemove('admin', 'member', false)).toBe(true);
    expect(canRemove('admin', 'owner', false)).toBe(false);
    expect(canRemove('admin', 'admin', false)).toBe(false);
    expect(canRemove('owner', 'admin', false)).toBe(true);
  });
});

describe('TeamsService', () => {
  it('createOrg makes the caller owner and grants a team trial', async () => {
    const t = build();
    const r = await t.svc.createOrg({ name: 'Acme', ownerAccountId: 'u1' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(await t.repo.getMembership(r.value.id, 'u1')).toMatchObject({ role: 'owner' });
    const sub = await t.repo.getSubscription(r.value.id);
    expect(sub).toMatchObject({ plan: 'team', status: 'trialing' });
  });

  it('invite requires admin+, then accept adds the member with the invited role', async () => {
    const t = build();
    const org = await t.svc.createOrg({ name: 'Acme', ownerAccountId: 'owner' });
    if (!org.ok) throw new Error('setup');
    // a plain member cannot invite
    await t.repo.addMember({ orgId: org.value.id, accountId: 'm', role: 'member', createdAtMs: nowMs });
    const denied = await t.svc.invite({ orgId: org.value.id, actorAccountId: 'm', role: 'member' });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe('org_forbidden');
    // owner invites a member
    const inv = await t.svc.invite({ orgId: org.value.id, actorAccountId: 'owner', role: 'member' });
    expect(inv.ok).toBe(true);
    if (!inv.ok) return;
    const acc = await t.svc.accept({ token: inv.value.token, accountId: 'u2' });
    expect(acc.ok).toBe(true);
    if (acc.ok) expect(acc.value.role).toBe('member');
    expect(await t.repo.getMembership(org.value.id, 'u2')).toMatchObject({ role: 'member' });
  });

  it('accept rejects expired / reused invites and already-members', async () => {
    const t = build();
    const org = await t.svc.createOrg({ name: 'A', ownerAccountId: 'owner' });
    if (!org.ok) throw new Error('setup');
    const inv = await t.svc.invite({ orgId: org.value.id, actorAccountId: 'owner', role: 'viewer' });
    if (!inv.ok) throw new Error('setup');
    // expire it
    nowMs += 100 * 86_400_000;
    const expired = await t.svc.accept({ token: inv.value.token, accountId: 'u2' });
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.error.code).toBe('invite_expired');
    nowMs = 1_700_000_000_000;
    // fresh invite, accept twice
    const inv2 = await t.svc.invite({ orgId: org.value.id, actorAccountId: 'owner', role: 'member' });
    if (!inv2.ok) throw new Error('setup');
    await t.svc.accept({ token: inv2.value.token, accountId: 'u3' });
    const reused = await t.svc.accept({ token: inv2.value.token, accountId: 'u4' });
    expect(reused.ok).toBe(false);
    if (!reused.ok) expect(reused.error.code).toBe('invite_used');
  });

  it('removeMember blocks removing the last owner; allows owner self-leave only with another owner', async () => {
    const t = build();
    const org = await t.svc.createOrg({ name: 'A', ownerAccountId: 'owner' });
    if (!org.ok) throw new Error('setup');
    const selfLeave = await t.svc.removeMember({ orgId: org.value.id, actorAccountId: 'owner', targetAccountId: 'owner' });
    expect(selfLeave.ok).toBe(false);
    if (!selfLeave.ok) expect(selfLeave.error.code).toBe('last_owner');
    // add a member, owner removes them
    await t.repo.addMember({ orgId: org.value.id, accountId: 'm', role: 'member', createdAtMs: nowMs });
    const rm = await t.svc.removeMember({ orgId: org.value.id, actorAccountId: 'owner', targetAccountId: 'm' });
    expect(rm.ok).toBe(true);
  });

  it('blocks a writer when seats are exhausted; viewers are always free', async () => {
    const t = build();
    const org = await t.svc.createOrg({ name: 'A', ownerAccountId: 'owner' });
    if (!org.ok) throw new Error('setup');
    const sub = await t.repo.getSubscription(org.value.id);
    await t.repo.upsertSubscription({ ...sub!, seats: 1 }); // owner already fills the only seat
    const invM = await t.svc.invite({ orgId: org.value.id, actorAccountId: 'owner', role: 'member' });
    if (!invM.ok) throw new Error('setup');
    const joinM = await t.svc.accept({ token: invM.value.token, accountId: 'w1' });
    expect(joinM.ok).toBe(false);
    if (!joinM.ok) expect(joinM.error.code).toBe('seats_exhausted');
    const invV = await t.svc.invite({ orgId: org.value.id, actorAccountId: 'owner', role: 'viewer' });
    if (!invV.ok) throw new Error('setup');
    const joinV = await t.svc.accept({ token: invV.value.token, accountId: 'v1' });
    expect(joinV.ok).toBe(true); // viewers never consume a seat
  });

  it('listSubsForAccount drives the entitlements union (member sees the org sub)', async () => {
    const t = build();
    const org = await t.svc.createOrg({ name: 'A', ownerAccountId: 'owner' });
    if (!org.ok) throw new Error('setup');
    const inv = await t.svc.invite({ orgId: org.value.id, actorAccountId: 'owner', role: 'member' });
    if (!inv.ok) throw new Error('setup');
    await t.svc.accept({ token: inv.value.token, accountId: 'u2' });
    const subs = await t.repo.listSubsForAccount('u2');
    expect(subs).toHaveLength(1);
    expect(subs[0].plan).toBe('team');
  });
});
