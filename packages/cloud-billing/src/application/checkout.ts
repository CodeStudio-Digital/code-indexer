/** Hosted-checkout / customer-portal handoff (the card surface stays on Stripe). */
import { type Result, ok, err, type AccountId } from '@cloudstudio/cloud-kernel';
import { type BillingError, BillingErrors } from '../domain/errors.js';
import type { BillingRepo, CheckoutSession, PaymentGateway } from '../domain/ports.js';
import type { PlanId } from '../domain/subscription.js';

export class CreateCheckoutUseCase {
  constructor(
    private readonly gateway: PaymentGateway,
    private readonly billing: BillingRepo,
  ) {}
  async execute(input: {
    accountId: AccountId;
    email: string;
    plan: PlanId;
  }): Promise<Result<CheckoutSession, BillingError>> {
    if (!this.gateway.configured) return err(BillingErrors.notConfigured());
    // Persist the Stripe customer id BEFORE sending the user to checkout, so a
    // dropped `checkout.session.completed` webhook can still be reconciled by
    // looking the subscription up against this customer (see ReconcileSubscription).
    const { stripeCustomerId } = await this.gateway.ensureCustomer({ accountId: input.accountId, email: input.email });
    await this.billing.setStripeCustomerId(input.accountId, stripeCustomerId);
    return ok(await this.gateway.createCheckout({ ...input, stripeCustomerId }));
  }
}

export class CreatePortalUseCase {
  constructor(
    private readonly gateway: PaymentGateway,
    private readonly billing: BillingRepo,
  ) {}
  async execute(input: { accountId: AccountId }): Promise<Result<CheckoutSession, BillingError>> {
    if (!this.gateway.configured) return err(BillingErrors.notConfigured());
    const sub = await this.billing.getSubscription(input.accountId);
    if (!sub?.stripeCustomerId) return err(BillingErrors.noCustomer());
    return ok(await this.gateway.createPortal({ accountId: input.accountId, stripeCustomerId: sub.stripeCustomerId }));
  }
}
