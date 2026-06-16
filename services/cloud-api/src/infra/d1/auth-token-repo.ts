/** OneTimeTokenRepo over a DbExecutor (auth_tokens). Expiry is epoch-ms, compared
 *  against `unixepoch('now')*1000` to dodge the SQLite ISO/datetime mismatch. */
import type { DbExecutor } from '@cloudstudio/cloud-kernel';
import { asAccountId } from '@cloudstudio/cloud-kernel';
import type { OneTimeTokenRepo } from '@cloudstudio/cloud-identity';

export function createAuthTokenRepo(db: DbExecutor): OneTimeTokenRepo {
  return {
    async create(input) {
      await db.run(
        'INSERT INTO auth_tokens (id, account_id, purpose, token_hash, expires_at) VALUES (?, ?, ?, ?, ?)',
        [input.id, input.accountId, input.purpose, input.tokenHash, input.expiresAtMs],
      );
    },
    async findValid(tokenHash, purpose) {
      const row = await db.first<{ id: string; account_id: string }>(
        `SELECT id, account_id FROM auth_tokens
         WHERE token_hash = ? AND purpose = ? AND consumed_at IS NULL AND expires_at > (unixepoch('now') * 1000)`,
        [tokenHash, purpose],
      );
      return row ? { id: row.id, accountId: asAccountId(row.account_id) } : null;
    },
    async consume(id, atIso) {
      const res = await db.run('UPDATE auth_tokens SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL', [
        atIso,
        id,
      ]);
      return res.rowsAffected > 0;
    },
    async consumeAllForAccount(accountId, purpose, atIso) {
      await db.run(
        'UPDATE auth_tokens SET consumed_at = ? WHERE account_id = ? AND purpose = ? AND consumed_at IS NULL',
        [atIso, accountId, purpose],
      );
    },
  };
}
