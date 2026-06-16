/** SessionRepo over a DbExecutor. */
import type { DbExecutor, SessionId } from '@cloudstudio/cloud-kernel';
import { asAccountId, asSessionId } from '@cloudstudio/cloud-kernel';
import type { NewSession, SessionRepo } from '@cloudstudio/cloud-identity';

export function createSessionRepo(db: DbExecutor): SessionRepo {
  return {
    async insert(s: NewSession) {
      await db.run('INSERT INTO sessions (id, account_id, user_agent, ip_hash) VALUES (?, ?, ?, ?)', [
        s.id,
        s.accountId,
        s.userAgent,
        s.ipHash,
      ]);
    },
    async findActive(id: SessionId) {
      const row = await db.first<{ id: string; account_id: string }>(
        'SELECT id, account_id FROM sessions WHERE id = ? AND revoked_at IS NULL',
        [id],
      );
      return row ? { id: asSessionId(row.id), accountId: asAccountId(row.account_id) } : null;
    },
    async touch(id: SessionId, atIso) {
      await db.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', [atIso, id]);
    },
    async revoke(id: SessionId, atIso) {
      await db.run('UPDATE sessions SET revoked_at = ? WHERE id = ?', [atIso, id]);
    },
    async listByAccount(accountId) {
      const rows = await db.all<{ id: string; user_agent: string | null; created_at: string; last_seen_at: string }>(
        'SELECT id, user_agent, created_at, last_seen_at FROM sessions WHERE account_id = ? AND revoked_at IS NULL ORDER BY last_seen_at DESC',
        [accountId],
      );
      return rows.map((r) => ({
        id: asSessionId(r.id),
        userAgent: r.user_agent,
        createdAt: r.created_at,
        lastSeenAt: r.last_seen_at,
      }));
    },
    async revokeAllForAccount(accountId, atIso) {
      await db.run('UPDATE sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL', [atIso, accountId]);
    },
  };
}
