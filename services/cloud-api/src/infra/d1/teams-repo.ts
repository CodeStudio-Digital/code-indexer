/** TeamsRepo over a DbExecutor (organizations, org_members, org_invites,
 *  org_subscriptions). createOrg is one atomic batch. */
import type { DbExecutor } from '@cloudstudio/cloud-kernel';
import type { PlanId, SubStatus } from '@cloudstudio/cloud-billing';
import type { Org, OrgInvite, OrgMember, OrgRole, OrgSubscription, TeamsRepo } from '../../teams/types.js';

interface OrgRow { id: string; slug: string; name: string; owner_account_id: string; kind: string; created_at_ms: number; }
interface MemberRow { org_id: string; account_id: string; role: string; created_at_ms: number; }
interface InviteRow { id: string; org_id: string; email_canonical: string | null; role: string; token_hash: string; status: string; invited_by: string; expires_at_ms: number; created_at_ms: number; }
interface SubRow { org_id: string; plan: string; status: string; period_end_ms: number | null; seats: number; trial_used: number; stripe_customer_id: string | null; stripe_subscription_id: string | null; }

const toOrg = (r: OrgRow): Org => ({ id: r.id, slug: r.slug, name: r.name, ownerAccountId: r.owner_account_id, kind: r.kind as Org['kind'], createdAtMs: r.created_at_ms });
const toMember = (r: MemberRow): OrgMember => ({ orgId: r.org_id, accountId: r.account_id, role: r.role as OrgRole, createdAtMs: r.created_at_ms });
const toInvite = (r: InviteRow): OrgInvite => ({ id: r.id, orgId: r.org_id, emailCanonical: r.email_canonical, role: r.role as OrgRole, tokenHash: r.token_hash, status: r.status as OrgInvite['status'], invitedBy: r.invited_by, expiresAtMs: r.expires_at_ms, createdAtMs: r.created_at_ms });
const toSub = (r: SubRow): OrgSubscription => ({ orgId: r.org_id, plan: r.plan as PlanId, status: r.status as SubStatus, periodEndMs: r.period_end_ms, seats: r.seats, trialUsed: r.trial_used === 1, stripeCustomerId: r.stripe_customer_id, stripeSubscriptionId: r.stripe_subscription_id });

export function createTeamsRepo(db: DbExecutor): TeamsRepo {
  return {
    async createOrg(org, owner, sub) {
      const stmts: { sql: string; params: unknown[] }[] = [
        { sql: 'INSERT INTO organizations (id, slug, name, owner_account_id, kind, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)', params: [org.id, org.slug, org.name, org.ownerAccountId, org.kind, org.createdAtMs] },
        { sql: 'INSERT INTO org_members (org_id, account_id, role, created_at_ms) VALUES (?, ?, ?, ?)', params: [owner.orgId, owner.accountId, owner.role, owner.createdAtMs] },
      ];
      if (sub) {
        stmts.push({
          sql: 'INSERT INTO org_subscriptions (org_id, plan, status, period_end_ms, seats, trial_used, stripe_customer_id, stripe_subscription_id, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          params: [sub.orgId, sub.plan, sub.status, sub.periodEndMs, sub.seats, sub.trialUsed ? 1 : 0, sub.stripeCustomerId, sub.stripeSubscriptionId, org.createdAtMs],
        });
      }
      await db.batch(stmts);
    },

    async getOrg(orgId) {
      const r = await db.first<OrgRow>('SELECT id, slug, name, owner_account_id, kind, created_at_ms FROM organizations WHERE id = ?', [orgId]);
      return r ? toOrg(r) : null;
    },

    async listForAccount(accountId) {
      const rows = await db.all<OrgRow & { role: string }>(
        `SELECT o.id, o.slug, o.name, o.owner_account_id, o.kind, o.created_at_ms, m.role
         FROM org_members m JOIN organizations o ON o.id = m.org_id
         WHERE m.account_id = ? ORDER BY o.created_at_ms DESC`,
        [accountId],
      );
      return rows.map((r) => ({ org: toOrg(r), role: r.role as OrgRole }));
    },

    async getMembership(orgId, accountId) {
      const r = await db.first<MemberRow>('SELECT org_id, account_id, role, created_at_ms FROM org_members WHERE org_id = ? AND account_id = ?', [orgId, accountId]);
      return r ? toMember(r) : null;
    },

    async listMembers(orgId) {
      const rows = await db.all<MemberRow>('SELECT org_id, account_id, role, created_at_ms FROM org_members WHERE org_id = ? ORDER BY created_at_ms ASC', [orgId]);
      return rows.map(toMember);
    },

    async countOwners(orgId) {
      const r = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM org_members WHERE org_id = ? AND role = 'owner'", [orgId]);
      return r?.n ?? 0;
    },

    async addMember(member) {
      await db.run('INSERT INTO org_members (org_id, account_id, role, created_at_ms) VALUES (?, ?, ?, ?) ON CONFLICT(org_id, account_id) DO NOTHING', [member.orgId, member.accountId, member.role, member.createdAtMs]);
    },

    async setRole(orgId, accountId, role) {
      await db.run('UPDATE org_members SET role = ? WHERE org_id = ? AND account_id = ?', [role, orgId, accountId]);
    },

    async removeMember(orgId, accountId) {
      await db.run('DELETE FROM org_members WHERE org_id = ? AND account_id = ?', [orgId, accountId]);
    },

    async insertInvite(invite) {
      await db.run(
        'INSERT INTO org_invites (id, org_id, email_canonical, role, token_hash, status, invited_by, expires_at_ms, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [invite.id, invite.orgId, invite.emailCanonical, invite.role, invite.tokenHash, invite.status, invite.invitedBy, invite.expiresAtMs, invite.createdAtMs],
      );
    },

    async findInviteByHash(tokenHash) {
      const r = await db.first<InviteRow>('SELECT id, org_id, email_canonical, role, token_hash, status, invited_by, expires_at_ms, created_at_ms FROM org_invites WHERE token_hash = ?', [tokenHash]);
      return r ? toInvite(r) : null;
    },

    async markInviteAccepted(id) {
      await db.run("UPDATE org_invites SET status = 'accepted' WHERE id = ?", [id]);
    },

    async getSubscription(orgId) {
      const r = await db.first<SubRow>('SELECT org_id, plan, status, period_end_ms, seats, trial_used, stripe_customer_id, stripe_subscription_id FROM org_subscriptions WHERE org_id = ?', [orgId]);
      return r ? toSub(r) : null;
    },

    async upsertSubscription(sub) {
      await db.run(
        `INSERT INTO org_subscriptions (org_id, plan, status, period_end_ms, seats, trial_used, stripe_customer_id, stripe_subscription_id, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(org_id) DO UPDATE SET
           plan = excluded.plan, status = excluded.status, period_end_ms = excluded.period_end_ms,
           seats = excluded.seats, trial_used = excluded.trial_used,
           stripe_customer_id = excluded.stripe_customer_id, stripe_subscription_id = excluded.stripe_subscription_id,
           updated_at_ms = excluded.updated_at_ms`,
        [sub.orgId, sub.plan, sub.status, sub.periodEndMs, sub.seats, sub.trialUsed ? 1 : 0, sub.stripeCustomerId, sub.stripeSubscriptionId, Date.now()],
      );
    },

    async listSubsForAccount(accountId) {
      const rows = await db.all<SubRow>(
        `SELECT s.org_id, s.plan, s.status, s.period_end_ms, s.seats, s.trial_used, s.stripe_customer_id, s.stripe_subscription_id
         FROM org_members m JOIN org_subscriptions s ON s.org_id = m.org_id
         WHERE m.account_id = ?`,
        [accountId],
      );
      return rows.map(toSub);
    },
  };
}
