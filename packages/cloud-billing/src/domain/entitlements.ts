/**
 * Entitlements are a PURE PROJECTION of subscription state — the single place
 * that decides what a tier unlocks. The server re-derives these on every gated
 * request (the client cache is only UX), so a stale/forged client can't grant
 * itself Pro. Pro = an active or trialing subscription that hasn't lapsed.
 */
import type { PlanId, SubStatus, Subscription } from './subscription.js';

export interface Entitlements {
  tier: PlanId;
  status: SubStatus;
  periodEndMs: number | null;
  features: { sharing: boolean; sync: boolean; prioritySupport: boolean };
  limits: { maxActiveShares: number };
}

const PRO_FEATURES: Entitlements['features'] = { sharing: true, sync: true, prioritySupport: true };
const FREE_FEATURES: Entitlements['features'] = { sharing: false, sync: false, prioritySupport: false };

export const TRIAL_DAYS = 14;

export function deriveEntitlements(sub: Subscription | null, nowMs: number): Entitlements {
  const isPro =
    !!sub &&
    (sub.status === 'active' || sub.status === 'trialing') &&
    (sub.periodEndMs == null || sub.periodEndMs > nowMs);

  if (isPro && sub) {
    return {
      tier: 'pro',
      status: sub.status,
      periodEndMs: sub.periodEndMs,
      features: PRO_FEATURES,
      limits: { maxActiveShares: 100 },
    };
  }
  return {
    tier: 'free',
    status: sub?.status ?? 'none',
    periodEndMs: sub?.periodEndMs ?? null,
    features: FREE_FEATURES,
    limits: { maxActiveShares: 1 },
  };
}
