/** RefreshTokenRepo over a DbExecutor. */
import type { DbExecutor } from '@cloudstudio/cloud-kernel';
import { asAccountId, asSessionId } from '@cloudstudio/cloud-kernel';
import type { NewRefreshToken, RefreshTokenRepo, StoredRefreshToken } from '@cloudstudio/cloud-identity';

interface RTRow {
  id: string;
  session_id: string;
  account_id: string;
  family_id: string;
  expires_at: string;
  consumed_at: string | null;
  revoked_at: string | null;
}

export function createRefreshTokenRepo(db: DbExecutor): RefreshTokenRepo {
  return {
    async insert(t: NewRefreshToken) {
      await db.run(
        'INSERT INTO refresh_tokens (id, session_id, account_id, token_hash, family_id, prev_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [t.id, t.sessionId, t.accountId, t.tokenHash, t.familyId, t.prevId, t.expiresAtIso],
      );
    },
    async findByHash(tokenHash): Promise<StoredRefreshToken | null> {
      const row = await db.first<RTRow>(
        'SELECT id, session_id, account_id, family_id, expires_at, consumed_at, revoked_at FROM refresh_tokens WHERE token_hash = ?',
        [tokenHash],
      );
      if (!row) return null;
      return {
        id: row.id,
        sessionId: asSessionId(row.session_id),
        accountId: asAccountId(row.account_id),
        familyId: row.family_id,
        expiresAtIso: row.expires_at,
        consumedAt: row.consumed_at,
        revokedAt: row.revoked_at,
      };
    },
    async consume(id, atIso) {
      const res = await db.run('UPDATE refresh_tokens SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL', [
        atIso,
        id,
      ]);
      return res.rowsAffected > 0;
    },
    async revokeFamily(familyId, atIso) {
      await db.run('UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL', [
        atIso,
        familyId,
      ]);
    },
    async revokeBySession(sessionId, atIso) {
      await db.run('UPDATE refresh_tokens SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL', [
        atIso,
        sessionId,
      ]);
    },
    async revokeByAccount(accountId, atIso) {
      await db.run('UPDATE refresh_tokens SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL', [
        atIso,
        accountId,
      ]);
    },
  };
}
