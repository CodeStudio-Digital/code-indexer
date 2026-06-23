/** AccountRepo over a DbExecutor. The credential read is the only path that
 *  exposes the password hash; everything else returns the hash-free entity. */
import type { DbExecutor, AccountId } from '@cloudstudio/cloud-kernel';
import { Account, type AccountRow, type AccountRepo, type NewAccount, type NewOAuthAccount } from '@cloudstudio/cloud-identity';

type CredRow = AccountRow & { password_hash: string };

// Sentinel password hash for OAuth-only accounts. `pbkdf2Hasher.verify` returns
// false for any non-PHC string (wrong prefix → parse() null), so no password can
// ever authenticate against this — password login is impossible until the user
// sets one on the web portal.
const OAUTH_SENTINEL_HASH = 'oauth$no-password';

export function createAccountRepo(db: DbExecutor): AccountRepo {
  return {
    async findByCanonical(canonical) {
      const row = await db.first<AccountRow>('SELECT * FROM accounts WHERE email_canonical = ?', [canonical]);
      return row ? Account.fromRow(row) : null;
    },
    async findById(id) {
      const row = await db.first<AccountRow>('SELECT * FROM accounts WHERE id = ?', [id]);
      return row ? Account.fromRow(row) : null;
    },
    async findCredentialByCanonical(canonical) {
      const row = await db.first<CredRow>('SELECT * FROM accounts WHERE email_canonical = ?', [canonical]);
      return row ? { account: Account.fromRow(row), passwordHash: row.password_hash } : null;
    },
    async insert(a: NewAccount) {
      await db.run(
        'INSERT INTO accounts (id, email, email_canonical, password_hash, status) VALUES (?, ?, ?, ?, ?)',
        [a.id, a.email, a.emailCanonical, a.passwordHash, 'active'],
      );
    },
    async insertOAuth(a: NewOAuthAccount) {
      await db.run(
        'INSERT INTO accounts (id, email, email_canonical, password_hash, status, email_verified_at) VALUES (?, ?, ?, ?, ?, ?)',
        [a.id, a.email, a.emailCanonical, OAUTH_SENTINEL_HASH, 'active', a.emailVerifiedAt],
      );
    },
    async updatePasswordHash(id: AccountId, phc) {
      await db.run("UPDATE accounts SET password_hash = ?, updated_at = datetime('now') WHERE id = ?", [phc, id]);
    },
    async markEmailVerified(id: AccountId, atIso) {
      await db.run("UPDATE accounts SET email_verified_at = ?, updated_at = datetime('now') WHERE id = ?", [atIso, id]);
    },
  };
}
