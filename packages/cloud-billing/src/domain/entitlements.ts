/**
 * Entitlements are a PURE PROJECTION of subscription state — the single place
 * that decides what a tier unlocks. The server re-derives these on every gated
 * request (the client cache is only UX), so a stale/forged client can't grant
 * itself a paid tier. A paid tier = an active or trialing subscription that
 * hasn't lapsed; the specific tier comes from the subscription's `plan`.
 *
 * Tiers form a ladder free < pro < team < enterprise. For now `deriveEntitlements`
 * projects a single (per-account) subscription, so it only ever yields free/pro.
 * team/enterprise become reachable once an org-owned subscription exists (P4),
 * where a resolver unions the account + org subjects and takes the max tier —
 * additive, because the per-tier table below already carries every tier.
 *
 * Limit convention: -1 means unlimited (JSON-safe, unlike Infinity).
 */
import type { PlanId, SubStatus, Subscription } from './subscription.js';

export interface EntitlementFeatures {
  /** Publish redacted conversation snapshots as public/unlisted links. */
  sharing: boolean;
  /** Sync personal collections / environment structure / memory across machines. */
  sync: boolean;
  prioritySupport: boolean;
  /** Publish a collection as a hosted, browsable API docs page (the wedge). */
  apiDocs: boolean;
  /** Periodic cloud backup of CodeStudio metadata (NOT source — that's in git). */
  backup: boolean;
  /** Shared, team-owned API workspaces (collections the agent can run/test). */
  teamApis: boolean;
  /** Shared team knowledge base / memory that conditions every member's agent. */
  teamMemory: boolean;
  /** Shared company/squad templates. */
  teamTemplates: boolean;
  /** SSO / SCIM. */
  sso: boolean;
  /** Org-wide audit log export. */
  auditExport: boolean;
}

export interface EntitlementLimits {
  /** Active shares the principal may keep published. -1 = unlimited. */
  maxActiveShares: number;
  /** Hosted API docs sites the principal may keep published. -1 = unlimited. */
  maxApiDocs: number;
  /** Writer seats. 1 for individual tiers; for team it is overridden by the
   *  purchased Stripe quantity at resolution time (P4). -1 = unlimited. */
  maxSeats: number;
}

export interface Entitlements {
  tier: PlanId;
  status: SubStatus;
  periodEndMs: number | null;
  features: EntitlementFeatures;
  limits: EntitlementLimits;
}

interface TierGrant {
  features: EntitlementFeatures;
  limits: EntitlementLimits;
}

const FREE_FEATURES: EntitlementFeatures = {
  sharing: false,
  sync: false,
  prioritySupport: false,
  apiDocs: false,
  backup: false,
  teamApis: false,
  teamMemory: false,
  teamTemplates: false,
  sso: false,
  auditExport: false,
};
const PRO_FEATURES: EntitlementFeatures = {
  ...FREE_FEATURES,
  sharing: true,
  sync: true,
  prioritySupport: true,
  apiDocs: true,
  backup: true,
};
const TEAM_FEATURES: EntitlementFeatures = {
  ...PRO_FEATURES,
  teamApis: true,
  teamMemory: true,
  teamTemplates: true,
};
const ENTERPRISE_FEATURES: EntitlementFeatures = {
  ...TEAM_FEATURES,
  sso: true,
  auditExport: true,
};

/** Per-tier grant table. Single source of truth for what each tier unlocks. */
const GRANTS: Record<PlanId, TierGrant> = {
  free: { features: FREE_FEATURES, limits: { maxActiveShares: 1, maxApiDocs: 1, maxSeats: 1 } },
  pro: { features: PRO_FEATURES, limits: { maxActiveShares: 100, maxApiDocs: 100, maxSeats: 1 } },
  team: { features: TEAM_FEATURES, limits: { maxActiveShares: 100, maxApiDocs: -1, maxSeats: -1 } },
  enterprise: { features: ENTERPRISE_FEATURES, limits: { maxActiveShares: -1, maxApiDocs: -1, maxSeats: -1 } },
};

export const TRIAL_DAYS = 14;

/** Tier ordering for "max wins" resolution (e.g., personal sub ∪ org membership). */
export const TIER_RANK: Record<PlanId, number> = { free: 0, pro: 1, team: 2, enterprise: 3 };

/** Pick the higher of two entitlement projections by tier rank (ties → `a`). */
export function maxEntitlements(a: Entitlements, b: Entitlements): Entitlements {
  return TIER_RANK[b.tier] > TIER_RANK[a.tier] ? b : a;
}

/** A subscription unlocks a paid tier iff it's active/trialing and not lapsed. */
export function isPaidActive(sub: Subscription | null, nowMs: number): boolean {
  return (
    !!sub &&
    (sub.status === 'active' || sub.status === 'trialing') &&
    (sub.periodEndMs == null || sub.periodEndMs > nowMs)
  );
}

export function deriveEntitlements(sub: Subscription | null, nowMs: number): Entitlements {
  // An active subscription whose plan is still 'free' is the legacy auto-trial
  // shape (a Pro trial); anything else uses the subscription's own plan.
  const tier: PlanId = isPaidActive(sub, nowMs) ? (sub!.plan === 'free' ? 'pro' : sub!.plan) : 'free';
  const grant = GRANTS[tier];
  return {
    tier,
    status: sub?.status ?? 'none',
    periodEndMs: sub?.periodEndMs ?? null,
    features: grant.features,
    limits: grant.limits,
  };
}
