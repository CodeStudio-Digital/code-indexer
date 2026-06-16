/**
 * Billing composition root — wires env bindings → D1 billing repo + Stripe
 * gateway → billing use-cases. Per request, mirroring `composition.ts`. Stripe
 * keys are optional: when absent the gateway reports `configured: false` and the
 * checkout/portal routes return 501 (the webhook + entitlements still work).
 */
import {
  CreateCheckoutUseCase,
  CreatePortalUseCase,
  GetEntitlementsUseCase,
  HandleSubscriptionEventUseCase,
  type BillingRepo,
  type PaymentGateway,
} from '@cloudstudio/cloud-billing';
import { createD1Executor } from './infra/d1/d1-executor.js';
import { createBillingRepo } from './infra/d1/billing-repo.js';
import { createStripeGateway } from './infra/stripe-gateway.js';
import { systemClock } from './infra/runtime.js';
import type { Env } from './env.js';

export interface BillingBundle {
  getEntitlements: GetEntitlementsUseCase;
  handleWebhook: HandleSubscriptionEventUseCase;
  createCheckout: CreateCheckoutUseCase;
  createPortal: CreatePortalUseCase;
  gateway: PaymentGateway;
  billing: BillingRepo;
}

export function createBillingBundle(env: Env): BillingBundle {
  const db = createD1Executor(env.DB);
  const billing = createBillingRepo(db);
  const gateway = createStripeGateway({
    secretKey: env.STRIPE_SECRET_KEY,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    proPriceId: env.STRIPE_PRO_PRICE_ID,
    appBaseUrl: env.APP_BASE_URL,
  });
  return {
    getEntitlements: new GetEntitlementsUseCase(billing, systemClock),
    handleWebhook: new HandleSubscriptionEventUseCase(billing),
    createCheckout: new CreateCheckoutUseCase(gateway),
    createPortal: new CreatePortalUseCase(gateway, billing),
    gateway,
    billing,
  };
}
