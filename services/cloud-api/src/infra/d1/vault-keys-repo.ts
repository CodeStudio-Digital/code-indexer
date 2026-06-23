/**
 * D1 repo for the SSH-vault key distribution (migration 0017): member public
 * keys + per-project TVK grants. No crypto here — the server only ever stores
 * opaque public keys + wrapped-key blobs. Mirrors the org-sync-repo executor
 * style so it runs on D1 in prod and a better-sqlite3 executor in tests.
 */
import type { DbExecutor } from '@cloudstudio/cloud-kernel';

export interface MemberPublicKey {
  accountId: string;
  publicSpki: string;
}
export interface VaultGrant {
  accountId: string;
  wrappedKey: string;
  granterPub: string;
  tvkId: string;
  granterSigPub: string;
  signature: string;
}

export function createVaultKeysRepo(db: DbExecutor) {
  return {
    async putMemberKey(accountId: string, publicSpki: string, nowMs: number): Promise<void> {
      await db.run(
        `INSERT INTO member_keys (account_id, public_spki, created_at_ms) VALUES (?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET public_spki = excluded.public_spki`,
        [accountId, publicSpki, nowMs],
      );
    },

    /** Public keys of org members who have published one (others can't be granted yet). */
    async listOrgMemberKeys(orgId: string): Promise<MemberPublicKey[]> {
      const rows = await db.all<{ account_id: string; public_spki: string }>(
        `SELECT m.account_id, k.public_spki
           FROM org_members m JOIN member_keys k ON k.account_id = m.account_id
          WHERE m.org_id = ?`,
        [orgId],
      );
      return rows.map((r) => ({ accountId: r.account_id, publicSpki: r.public_spki }));
    },

    async putGrants(orgId: string, projectWorkspaceId: string, grants: VaultGrant[], nowMs: number): Promise<void> {
      if (grants.length === 0) return;
      await db.batch(
        grants.map((g) => ({
          sql: `INSERT INTO org_vault_grants
                  (org_id, project_workspace_id, account_id, wrapped_key, granter_pub, tvk_id, granter_sig_pub, signature, created_at_ms)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(org_id, project_workspace_id, account_id) DO UPDATE SET
                  wrapped_key = excluded.wrapped_key, granter_pub = excluded.granter_pub,
                  tvk_id = excluded.tvk_id, granter_sig_pub = excluded.granter_sig_pub,
                  signature = excluded.signature, created_at_ms = excluded.created_at_ms`,
          params: [orgId, projectWorkspaceId, g.accountId, g.wrappedKey, g.granterPub, g.tvkId, g.granterSigPub, g.signature, nowMs],
        })),
      );
    },

    async getMyGrant(orgId: string, projectWorkspaceId: string, accountId: string): Promise<VaultGrant | null> {
      const r = await db.first<{
        account_id: string;
        wrapped_key: string;
        granter_pub: string;
        tvk_id: string;
        granter_sig_pub: string;
        signature: string;
      }>(
        `SELECT account_id, wrapped_key, granter_pub, tvk_id, granter_sig_pub, signature FROM org_vault_grants
          WHERE org_id = ? AND project_workspace_id = ? AND account_id = ?`,
        [orgId, projectWorkspaceId, accountId],
      );
      return r
        ? {
            accountId: r.account_id,
            wrappedKey: r.wrapped_key,
            granterPub: r.granter_pub,
            tvkId: r.tvk_id,
            granterSigPub: r.granter_sig_pub,
            signature: r.signature,
          }
        : null;
    },

    /** Drop all grants for a shared project — used on rotation. */
    async deleteGrants(orgId: string, projectWorkspaceId: string): Promise<void> {
      await db.run('DELETE FROM org_vault_grants WHERE org_id = ? AND project_workspace_id = ?', [
        orgId,
        projectWorkspaceId,
      ]);
    },

    /** Purge one member's grants across the org — called when they are removed. */
    async deleteGrantsForAccount(orgId: string, accountId: string): Promise<void> {
      await db.run('DELETE FROM org_vault_grants WHERE org_id = ? AND account_id = ?', [orgId, accountId]);
    },
  };
}
