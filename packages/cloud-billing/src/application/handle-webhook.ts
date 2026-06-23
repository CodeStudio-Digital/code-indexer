/**
 * Project a VERIFIED subscription event into D1, idempotently. Stripe re-delivers
 * webhooks, so we dedupe by event id and apply each exactly once. Subscription
 * state in D1 is the projection; entitlements are derived from it.
 */
import type { BillingRepo, SubscriptionEvent } from '../domain/ports.js';

export class HandleSubscriptionEventUseCase {
  constructor(private readonly billing: BillingRepo) {}

  async execute(event: SubscriptionEvent): Promise<{ applied: boolean }> {
    // Idempotency: first-seen gate. A replay is a no-op (already applied).
    if (!(await this.billing.recordWebhookEvent(event.eventId))) return { applied: false };
    await this.billing.upsertSubscription({
      accountId: event.accountId,
      plan: event.plan,
      status: event.status,
      periodEndMs: event.periodEndMs,
      trialUsed: true, // engaging billing burns the one-shot trial
      stripeCustomerId: event.stripeCustomerId,
    });
    return { applied: true };
  }
}
