/** Subscription state — the single source of truth that entitlements project from. */
import type { AccountId } from '@cloudstudio/cloud-kernel';

export type PlanId = 'free' | 'pro';
export type SubStatus = 'none' | 'trialing' | 'active' | 'past_due' | 'canceled';

export interface Subscription {
  accountId: AccountId;
  plan: PlanId;
  status: SubStatus;
  /** Current period / trial end, epoch ms; null when not time-bounded. */
  periodEndMs: number | null;
  /** Once true, the one-shot trial can never be granted again. */
  trialUsed: boolean;
  stripeCustomerId: string | null;
}
