/** AccountRepo over a DbExecutor. The credential read is the only path that
 *  exposes the password hash; everything else returns the hash-free entity. */
import type { DbExecutor, AccountId } from '@cloudstudio/cloud-kernel';
import { Account, type AccountRow, type AccountRepo, type NewAccount } from '@cloudstudio/cloud-identity';

type CredRow = AccountRow & { password_hash: string };

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
    async updatePasswordHash(id: AccountId, phc) {
      await db.run("UPDATE accounts SET password_hash = ?, updated_at = datetime('now') WHERE id = ?", [phc, id]);
    },
    async markEmailVerified(id: AccountId, atIso) {
      await db.run("UPDATE accounts SET email_verified_at = ?, updated_at = datetime('now') WHERE id = ?", [atIso, id]);
    },
  };
}
