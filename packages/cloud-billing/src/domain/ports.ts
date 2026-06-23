/** Billing ports — Stripe (or any provider) behind PaymentGateway; D1 behind BillingRepo. */
import type { AccountId } from '@cloudstudio/cloud-kernel';
import type { PlanId, SubStatus, Subscription } from './subscription.js';

export interface CheckoutSession {
  url: string;
}

/** A verified, provider-agnostic subscription change (the webhook payload, parsed). */
export interface SubscriptionEvent {
  eventId: string;
  accountId: AccountId;
  plan: PlanId;
  status: SubStatus;
  periodEndMs: number | null;
  stripeCustomerId: string | null;
}

export interface PaymentGateway {
  /** Whether real provider credentials are present (false ⇒ the routes 501). */
  readonly configured: boolean;
  createCheckout(input: { accountId: AccountId; email: string; plan: PlanId }): Promise<CheckoutSession>;
  createPortal(input: { accountId: AccountId; stripeCustomerId: string }): Promise<CheckoutSession>;
  /** Verify the signature + parse a subscription webhook. Returns null for
   *  events we ignore; throws on an invalid signature. */
  parseWebhook(rawBody: string, signature: string): Promise<SubscriptionEvent | null>;
}

export interface BillingRepo {
  getSubscription(accountId: AccountId): Promise<Subscription | null>;
  upsertSubscription(sub: Subscription): Promise<void>;
  /** One-shot trial: creates a trialing row only if the account never trialed.
   *  Returns false if a trial was already used (no double-dipping). */
  startTrial(accountId: AccountId, periodEndMs: number): Promise<boolean>;
  /** Idempotency gate: true iff this is the FIRST time eventId is recorded. */
  recordWebhookEvent(eventId: string): Promise<boolean>;
}
