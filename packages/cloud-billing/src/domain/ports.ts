/** Billing ports — Stripe (or any provider) behind PaymentGateway; D1 behind BillingRepo. */
import type { AccountId } from '@cloudstudio/cloud-kernel';
import type { PlanId, SubStatus, Subscription } from './subscription.js';

export interface CheckoutSession {
  url: string;
}

/** The plan-bearing fields of a subscription, independent of WHO owns it or which
 *  event delivered it. Shared by the webhook projection (which adds accountId +
 *  eventId) and reconciliation (which already knows the account). */
export interface SubscriptionSnapshot {
  plan: PlanId;
  status: SubStatus;
  periodEndMs: number | null;
  stripeCustomerId: string | null;
}

/** A verified, provider-agnostic subscription change (the webhook payload, parsed). */
export interface SubscriptionEvent extends SubscriptionSnapshot {
  eventId: string;
  accountId: AccountId;
}

export interface PaymentGateway {
  /** Whether real provider credentials are present (false ⇒ the routes 501). */
  readonly configured: boolean;
  createCheckout(input: {
    accountId: AccountId;
    email: string;
    plan: PlanId;
    /** Reuse this Stripe customer instead of `customer_email` (set after `ensureCustomer`). */
    stripeCustomerId?: string;
    /** Override the success/cancel return base (defaults to the portal). */
    returnBaseUrl?: string;
  }): Promise<CheckoutSession>;
  createPortal(input: { accountId: AccountId; stripeCustomerId: string }): Promise<CheckoutSession>;
  /** Verify the signature + parse a subscription webhook. Returns null for
   *  events we ignore; throws on an invalid signature. */
  parseWebhook(rawBody: string, signature: string): Promise<SubscriptionEvent | null>;
  /** Find-or-create the Stripe customer for an account (idempotent by email +
   *  metadata.accountId). Lets checkout persist the customer id up-front so a
   *  missed webhook can be reconciled later. */
  ensureCustomer(input: { accountId: AccountId; email: string }): Promise<{ stripeCustomerId: string }>;
  /** Look up a Stripe customer by email (reconciliation fallback when no local
   *  customer id was persisted). Null if none. */
  findCustomerByEmail(email: string): Promise<{ stripeCustomerId: string } | null>;
  /** List a customer's current subscriptions (reconciliation reads live state). */
  listSubscriptions(stripeCustomerId: string): Promise<SubscriptionSnapshot[]>;
}

export interface BillingRepo {
  getSubscription(accountId: AccountId): Promise<Subscription | null>;
  upsertSubscription(sub: Subscription): Promise<void>;
  /** Persist the Stripe customer id WITHOUT touching plan/status/trial_used —
   *  called at checkout so reconciliation has a key even if the webhook is lost. */
  setStripeCustomerId(accountId: AccountId, stripeCustomerId: string): Promise<void>;
  /** One-shot trial: creates a trialing row only if the account never trialed.
   *  Returns false if a trial was already used (no double-dipping). */
  startTrial(accountId: AccountId, periodEndMs: number): Promise<boolean>;
  /** Idempotency gate: true iff this is the FIRST time eventId is recorded. */
  recordWebhookEvent(eventId: string): Promise<boolean>;
}
