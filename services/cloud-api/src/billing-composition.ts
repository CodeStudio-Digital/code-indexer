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
  ReconcileSubscriptionUseCase,
  type BillingRepo,
  type PaymentGateway,
} from '@cloudstudio/cloud-billing';
import { createD1Executor } from './infra/d1/d1-executor.js';
import { createBillingRepo } from './infra/d1/billing-repo.js';
import { createStripeGateway, type StripeConfig } from './infra/stripe-gateway.js';
import { systemClock } from './infra/runtime.js';
import type { Env } from './env.js';

/** Build the Stripe config from env — shared by the personal gateway and the
 *  org (per-seat) checkout/portal helpers. */
export function stripeConfig(env: Env): StripeConfig {
  return {
    secretKey: env.STRIPE_SECRET_KEY,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    proPriceId: env.STRIPE_PRO_PRICE_ID,
    teamsPriceId: env.STRIPE_TEAMS_PRICE_ID,
    appBaseUrl: env.APP_BASE_URL,
    portalBaseUrl: env.PORTAL_BASE_URL ?? env.APP_BASE_URL,
  };
}

export interface BillingBundle {
  getEntitlements: GetEntitlementsUseCase;
  handleWebhook: HandleSubscriptionEventUseCase;
  createCheckout: CreateCheckoutUseCase;
  createPortal: CreatePortalUseCase;
  reconcile: ReconcileSubscriptionUseCase;
  gateway: PaymentGateway;
  billing: BillingRepo;
}

export function createBillingBundle(env: Env): BillingBundle {
  const db = createD1Executor(env.DB);
  const billing = createBillingRepo(db);
  const gateway = createStripeGateway(stripeConfig(env));
  return {
    getEntitlements: new GetEntitlementsUseCase(billing, systemClock),
    handleWebhook: new HandleSubscriptionEventUseCase(billing),
    createCheckout: new CreateCheckoutUseCase(gateway, billing),
    createPortal: new CreatePortalUseCase(gateway, billing),
    reconcile: new ReconcileSubscriptionUseCase(gateway, billing),
    gateway,
    billing,
  };
}
