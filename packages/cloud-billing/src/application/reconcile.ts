/**
 * Self-healing reconciliation: re-read the customer's LIVE subscription state from
 * the provider and project it into D1. This closes the "paid but the webhook was
 * dropped" hole — the only other writer of a paid row is the webhook, and the
 * 14-day trial lapses, so a missed webhook would silently downgrade a paying user.
 *
 * Safety invariant: reconciliation NEVER writes a `free`/`canceled` row. An empty
 * or transient read must not wipe a still-valid subscription — only the webhook
 * (the authority for transitions) downgrades. Reconciliation only ever UPGRADES.
 */
import { type Result, ok, err, type AccountId } from '@cloudstudio/cloud-kernel';
import { type BillingError, BillingErrors } from '../domain/errors.js';
import type { BillingRepo, PaymentGateway, SubscriptionSnapshot } from '../domain/ports.js';

export class ReconcileSubscriptionUseCase {
  constructor(
    private readonly gateway: PaymentGateway,
    private readonly billing: BillingRepo,
  ) {}

  async execute(input: { accountId: AccountId; email: string }): Promise<Result<{ applied: boolean }, BillingError>> {
    if (!this.gateway.configured) return err(BillingErrors.notConfigured());
    const local = await this.billing.getSubscription(input.accountId);
    const customerId =
      local?.stripeCustomerId ?? (await this.gateway.findCustomerByEmail(input.email))?.stripeCustomerId ?? null;
    if (!customerId) return ok({ applied: false });
    const winner = pickActive(await this.gateway.listSubscriptions(customerId));
    if (!winner) return ok({ applied: false }); // no live sub ⇒ leave the existing row untouched
    await this.billing.upsertSubscription({
      accountId: input.accountId,
      plan: winner.plan,
      status: winner.status,
      periodEndMs: winner.periodEndMs,
      trialUsed: true, // engaging billing burns the one-shot trial (parity with the webhook)
      stripeCustomerId: customerId,
    });
    return ok({ applied: true });
  }
}

/** Choose the subscription that should drive entitlements: a live one (active >
 *  trialing), preferring the one whose coverage extends furthest (null = unbounded
 *  wins). Returns null when nothing is live — the caller must then leave D1 as-is. */
export function pickActive(subs: readonly SubscriptionSnapshot[]): SubscriptionSnapshot | null {
  const live = subs.filter((s) => s.status === 'active' || s.status === 'trialing');
  if (live.length === 0) return null;
  return live.reduce((best, s) => (isBetter(s, best) ? s : best));
}

function statusRank(s: SubscriptionSnapshot): number {
  return s.status === 'active' ? 2 : 1; // active outranks trialing
}

function isBetter(a: SubscriptionSnapshot, b: SubscriptionSnapshot): boolean {
  if (statusRank(a) !== statusRank(b)) return statusRank(a) > statusRank(b);
  return (a.periodEndMs ?? Infinity) > (b.periodEndMs ?? Infinity);
}
