/**
 * Effective entitlements = the MAX (by tier) of a user's PERSONAL subscription and
 * EVERY org they belong to. This is the single resolver used by the entitlements
 * route AND every feature gate (docs/sync/backups), so a team member inherits the
 * team's tier everywhere. The personal projection still auto-grants the one-shot
 * personal trial on first touch (unchanged); orgs are layered on top.
 */
import { asAccountId } from '@cloudstudio/cloud-kernel';
import { deriveEntitlements, maxEntitlements, type Entitlements } from '@cloudstudio/cloud-billing';
import { createD1Executor } from './infra/d1/d1-executor.js';
import { createTeamsRepo } from './infra/d1/teams-repo.js';
import { createBillingBundle } from './billing-composition.js';
import { systemClock } from './infra/runtime.js';
import type { Env } from './env.js';

/**
 * The entitlements of ONE organization (its own subscription), used to gate
 * shared-workspace features per-org — NOT the member's union (a user in a paid
 * org X must not get team features inside an unpaid org Y).
 */
export async function resolveOrgEntitlements(env: Env, orgId: string): Promise<Entitlements> {
  const sub = await createTeamsRepo(createD1Executor(env.DB)).getSubscription(orgId);
  return deriveEntitlements(
    sub ? { accountId: asAccountId('org'), plan: sub.plan, status: sub.status, periodEndMs: sub.periodEndMs, trialUsed: sub.trialUsed, stripeCustomerId: sub.stripeCustomerId } : null,
    systemClock.now(),
  );
}

export async function resolveEntitlements(env: Env, accountId: string): Promise<Entitlements> {
  const acc = asAccountId(accountId);
  const personal = await createBillingBundle(env).getEntitlements.execute({ accountId: acc });
  const orgSubs = await createTeamsRepo(createD1Executor(env.DB)).listSubsForAccount(accountId);
  if (!orgSubs.length) return personal;
  const now = systemClock.now();
  let eff = personal;
  for (const s of orgSubs) {
    const orgEnt = deriveEntitlements(
      { accountId: acc, plan: s.plan, status: s.status, periodEndMs: s.periodEndMs, trialUsed: s.trialUsed, stripeCustomerId: s.stripeCustomerId },
      now,
    );
    eff = maxEntitlements(eff, orgEnt);
  }
  return eff;
}
