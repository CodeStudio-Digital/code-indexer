/** Hosted-checkout / customer-portal handoff (the card surface stays on Stripe). */
import { type Result, ok, err, type AccountId } from '@cloudstudio/cloud-kernel';
import { type BillingError, BillingErrors } from '../domain/errors.js';
import type { BillingRepo, CheckoutSession, PaymentGateway } from '../domain/ports.js';
import type { PlanId } from '../domain/subscription.js';

export class CreateCheckoutUseCase {
  constructor(private readonly gateway: PaymentGateway) {}
  async execute(input: {
    accountId: AccountId;
    email: string;
    plan: PlanId;
  }): Promise<Result<CheckoutSession, BillingError>> {
    if (!this.gateway.configured) return err(BillingErrors.notConfigured());
    return ok(await this.gateway.createCheckout(input));
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
