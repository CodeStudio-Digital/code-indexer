/** BillingRepo over a DbExecutor (subscriptions + billing_webhook_events).
 *  period_end_ms is epoch ms (INTEGER); trial_used is a 0/1 one-shot latch. */
import type { DbExecutor } from '@cloudstudio/cloud-kernel';
import { asAccountId, type AccountId } from '@cloudstudio/cloud-kernel';
import type { BillingRepo, PlanId, SubStatus, Subscription } from '@cloudstudio/cloud-billing';

interface Row {
  account_id: string;
  plan: string;
  status: string;
  period_end_ms: number | null;
  trial_used: number;
  stripe_customer_id: string | null;
}

export function createBillingRepo(db: DbExecutor): BillingRepo {
  return {
    async getSubscription(accountId: AccountId) {
      const row = await db.first<Row>(
        `SELECT account_id, plan, status, period_end_ms, trial_used, stripe_customer_id
         FROM subscriptions WHERE account_id = ?`,
        [accountId],
      );
      return row ? toSubscription(row) : null;
    },

    async upsertSubscription(sub: Subscription) {
      await db.run(
        `INSERT INTO subscriptions (account_id, plan, status, period_end_ms, trial_used, stripe_customer_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(account_id) DO UPDATE SET
           plan = excluded.plan, status = excluded.status, period_end_ms = excluded.period_end_ms,
           trial_used = excluded.trial_used, stripe_customer_id = excluded.stripe_customer_id,
           updated_at = datetime('now')`,
        [sub.accountId, sub.plan, sub.status, sub.periodEndMs, sub.trialUsed ? 1 : 0, sub.stripeCustomerId],
      );
    },

    async startTrial(accountId: AccountId, periodEndMs: number) {
      // Atomic one-shot: create/flip to trialing only if no trial was ever used.
      // The WHERE guard on the conflict path makes a concurrent double-grant a no-op.
      const res = await db.run(
        `INSERT INTO subscriptions (account_id, plan, status, period_end_ms, trial_used, updated_at)
         VALUES (?, 'pro', 'trialing', ?, 1, datetime('now'))
         ON CONFLICT(account_id) DO UPDATE SET
           plan = 'pro', status = 'trialing', period_end_ms = excluded.period_end_ms,
           trial_used = 1, updated_at = datetime('now')
         WHERE subscriptions.trial_used = 0`,
        [accountId, periodEndMs],
      );
      return res.rowsAffected > 0;
    },

    async recordWebhookEvent(eventId: string) {
      const res = await db.run('INSERT OR IGNORE INTO billing_webhook_events (event_id) VALUES (?)', [eventId]);
      return res.rowsAffected > 0;
    },
  };
}

function toSubscription(r: Row): Subscription {
  return {
    accountId: asAccountId(r.account_id),
    plan: r.plan as PlanId,
    status: r.status as SubStatus,
    periodEndMs: r.period_end_ms,
    trialUsed: r.trial_used === 1,
    stripeCustomerId: r.stripe_customer_id,
  };
}
