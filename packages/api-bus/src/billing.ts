import type { ApiContext } from './common.js';

/**
 * Billing = Stripe subscription management. Like `auth.ts`, the local
 * backend is a thin proxy to `worker-license` — the Worker holds the
 * Stripe secret key and receives webhooks at `/api/billing/webhook`.
 *
 * Tier changes propagate via:
 *   Stripe webhook → Worker → D1 → next `auth.me()` returns updated JWT
 *   → backend cache refreshed → UI hook `useUserTier()` re-renders.
 *
 * The dashboard triggers `electronAPI.openExternal(url)` to open
 * Stripe-hosted checkout/portal pages — local backend never sees the
 * card number.
 */

export type PlanId = 'pro_monthly' | 'pro_yearly';

export interface BillingApi {
  /** Create a Stripe Checkout session and return the hosted URL. */
  createCheckoutSession(input: { plan: PlanId }, ctx: ApiContext): Promise<{ url: string; sessionId: string }>;

  /** Open the Stripe Customer Portal (manage subscription, cancel, update card). */
  createPortalSession(input: void, ctx: ApiContext): Promise<{ url: string }>;

  /** Snapshot of the user's current subscription state (mirrors D1). */
  subscription(input: void, ctx: ApiContext): Promise<{
    status: 'none' | 'active' | 'trialing' | 'past_due' | 'canceled' | 'unpaid';
    plan: PlanId | null;
    current_period_end: number | null;
    cancel_at_period_end: boolean;
  }>;

  /**
   * Poll endpoint the UI hits after Checkout to detect when the webhook
   * has updated the tier. Returns the latest tier; UI breaks the poll
   * once it transitions from `free` to `pro`.
   */
  pollAfterCheckout(input: { sessionId: string }, ctx: ApiContext): Promise<{ tier: 'free' | 'pro'; settled: boolean }>;
}
