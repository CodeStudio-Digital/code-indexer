/** TwoFactorRepo over a DbExecutor (totp_secrets + recovery_codes). */
import type { DbExecutor, IdGen } from '@cloudstudio/cloud-kernel';
import type { TwoFactorRepo } from '@cloudstudio/cloud-identity';

export function createTwoFactorRepo(db: DbExecutor, ids: IdGen): TwoFactorRepo {
  return {
    async getSecret(accountId) {
      const row = await db.first<{ secret: string; enabled: number }>(
        'SELECT secret, enabled FROM totp_secrets WHERE account_id = ?',
        [accountId],
      );
      return row ? { secret: row.secret, enabled: row.enabled === 1 } : null;
    },
    async upsertPending(accountId, secret) {
      await db.run(
        `INSERT INTO totp_secrets (account_id, secret, enabled) VALUES (?, ?, 0)
         ON CONFLICT(account_id) DO UPDATE SET secret = excluded.secret, enabled = 0, updated_at = datetime('now')`,
        [accountId, secret],
      );
    },
    async enable(accountId) {
      await db.run("UPDATE totp_secrets SET enabled = 1, updated_at = datetime('now') WHERE account_id = ?", [accountId]);
    },
    async disable(accountId) {
      await db.batch([
        { sql: 'DELETE FROM totp_secrets WHERE account_id = ?', params: [accountId] },
        { sql: 'DELETE FROM recovery_codes WHERE account_id = ?', params: [accountId] },
      ]);
    },
    async addRecoveryCodes(accountId, hashes) {
      if (hashes.length === 0) return;
      // Replace any prior set so a re-confirm issues exactly these codes.
      await db.batch([
        { sql: 'DELETE FROM recovery_codes WHERE account_id = ?', params: [accountId] },
        ...hashes.map((h) => ({
          sql: 'INSERT INTO recovery_codes (id, account_id, code_hash) VALUES (?, ?, ?)',
          params: [ids.uuid(), accountId, h],
        })),
      ]);
    },
    async consumeRecoveryCode(accountId, hash) {
      const res = await db.run(
        "UPDATE recovery_codes SET used_at = datetime('now') WHERE account_id = ? AND code_hash = ? AND used_at IS NULL",
        [accountId, hash],
      );
      return res.rowsAffected > 0;
    },
  };
}
