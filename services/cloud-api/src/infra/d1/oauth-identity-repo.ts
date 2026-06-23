/** OAuthIdentityRepo over a DbExecutor — the (provider, provider_user_id) link
 *  table that maps a Google/GitHub/Microsoft subject to a CodeStudio account. */
import type { DbExecutor } from '@cloudstudio/cloud-kernel';
import { asAccountId } from '@cloudstudio/cloud-kernel';
import type { NewOAuthIdentity, OAuthIdentityRepo } from '@cloudstudio/cloud-identity';

export function createOAuthIdentityRepo(db: DbExecutor): OAuthIdentityRepo {
  return {
    async findByProviderUser(provider, providerUserId) {
      const row = await db.first<{ account_id: string }>(
        'SELECT account_id FROM oauth_identities WHERE provider = ? AND provider_user_id = ?',
        [provider, providerUserId],
      );
      return row ? { accountId: asAccountId(row.account_id) } : null;
    },
    async link(i: NewOAuthIdentity) {
      await db.run(
        'INSERT INTO oauth_identities (id, provider, provider_user_id, account_id, email_at_link) VALUES (?, ?, ?, ?, ?)',
        [i.id, i.provider, i.providerUserId, i.accountId, i.emailAtLink],
      );
    },
  };
}
