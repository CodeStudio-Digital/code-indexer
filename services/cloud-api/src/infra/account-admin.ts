/** Account erasure. A hard DELETE relies on the FK cascades to wipe sessions,
 *  refresh tokens, TOTP, recovery codes, subscriptions, shares + share messages,
 *  and feedback attachments; feedback_tickets.account_id is SET NULL (anonymized).
 *  True GDPR/LGPD erasure in one statement — the audit_log row has no FK and survives. */
import type { DbExecutor } from '@cloudstudio/cloud-kernel';

export interface AccountAdmin {
  hardDelete(accountId: string): Promise<void>;
}

export function createAccountAdmin(db: DbExecutor): AccountAdmin {
  return {
    async hardDelete(accountId) {
      await db.run('DELETE FROM accounts WHERE id = ?', [accountId]);
    },
  };
}

/**
 * Erase the account's R2 objects (feedback attachments live under
 * `feedback/<accountId>/`). A DB-row cascade does NOT touch R2, so without this
 * the user's uploaded images would survive a right-to-erasure request. Paginates
 * the prefix and deletes in batches. Returns the count erased.
 */
export async function purgeAccountBlobs(bucket: R2Bucket, accountId: string): Promise<number> {
  const prefix = `feedback/${accountId}/`;
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, cursor });
    const keys = listed.objects.map((o) => o.key);
    if (keys.length) {
      await bucket.delete(keys);
      deleted += keys.length;
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return deleted;
}
