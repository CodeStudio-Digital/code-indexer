/**
 * Billing domain + use-case tests with fake ports (no D1, no Stripe, no WASM).
 * Covers the entitlement projection truth table, the one-shot trial state
 * machine, webhook idempotency, and the billing_not_configured / no_customer
 * guards on checkout/portal.
 */
import { describe, it, expect } from 'vitest';
import { type Clock, asAccountId, type AccountId } from '@cloudstudio/cloud-kernel';
import {
  deriveEntitlements,
  GetEntitlementsUseCase,
  HandleSubscriptionEventUseCase,
  CreateCheckoutUseCase,
  CreatePortalUseCase,
  type BillingRepo,
  type CheckoutSession,
  type PaymentGateway,
  type Subscription,
  type SubscriptionEvent,
} from '@cloudstudio/cloud-billing';

const NOW = 1_700_000_000_000;
const clock: Clock = { now: () => NOW, isoNow: () => new Date(NOW).toISOString() };
const acc = asAccountId('acc1');

function sub(p: Partial<Subscription>): Subscription {
  return {
    accountId: acc,
    plan: 'free',
    status: 'none',
    periodEndMs: null,
    trialUsed: false,
    stripeCustomerId: null,
    ...p,
  };
}

class FakeBillingRepo implements BillingRepo {
  store = new Map<string, Subscription>();
  events = new Set<string>();
  async getSubscription(accountId: AccountId) {
    return this.store.get(accountId) ?? null;
  }
  async upsertSubscription(s: Subscription) {
    this.store.set(s.accountId, s);
  }
  async startTrial(accountId: AccountId, periodEndMs: number) {
    const existing = this.store.get(accountId);
    if (existing?.trialUsed) return false; // one-shot latch
    this.store.set(accountId, sub({ plan: 'pro', status: 'trialing', periodEndMs, trialUsed: true }));
    return true;
  }
  async recordWebhookEvent(eventId: string) {
    if (this.events.has(eventId)) return false;
    this.events.add(eventId);
    return true;
  }
}

class FakeGateway implements PaymentGateway {
  constructor(public configured: boolean) {}
  async createCheckout(): Promise<CheckoutSession> {
    return { url: 'https://checkout.stripe.test/c/1' };
  }
  async createPortal(): Promise<CheckoutSession> {
    return { url: 'https://billing.stripe.test/p/1' };
  }
  async parseWebhook(): Promise<SubscriptionEvent | null> {
    return null;
  }
}

describe('deriveEntitlements (projection truth table)', () => {
  it('active subscription → pro', () => {
    expect(deriveEntitlements(sub({ plan: 'pro', status: 'active' }), NOW).tier).toBe('pro');
  });
  it('trialing within period → pro', () => {
    expect(deriveEntitlements(sub({ plan: 'pro', status: 'trialing', periodEndMs: NOW + 1000 }), NOW).tier).toBe('pro');
  });
  it('trialing but lapsed (periodEnd in past) → free', () => {
    expect(deriveEntitlements(sub({ plan: 'pro', status: 'trialing', periodEndMs: NOW - 1000 }), NOW).tier).toBe('free');
  });
  it('past_due → free (writes blocked)', () => {
    expect(deriveEntitlements(sub({ status: 'past_due' }), NOW).tier).toBe('free');
  });
  it('canceled → free', () => {
    expect(deriveEntitlements(sub({ status: 'canceled' }), NOW).tier).toBe('free');
  });
  it('no subscription at all → free', () => {
    const ent = deriveEntitlements(null, NOW);
    expect(ent.tier).toBe('free');
    expect(ent.features.sharing).toBe(false);
  });
});

describe('deriveEntitlements (tier ladder + feature flags)', () => {
  it('free unlocks nothing and caps docs/seats at 1', () => {
    const ent = deriveEntitlements(null, NOW);
    expect(ent.features.apiDocs).toBe(false);
    expect(ent.features.backup).toBe(false);
    expect(ent.features.sshVault).toBe(false);
    expect(ent.features.teamSshVault).toBe(false);
    expect(ent.limits).toEqual({ maxActiveShares: 1, maxApiDocs: 1, maxSeats: 1 });
  });
  it('pro unlocks apiDocs + backup + sync + sshVault but no team features', () => {
    const ent = deriveEntitlements(sub({ plan: 'pro', status: 'active' }), NOW);
    expect(ent.features.apiDocs).toBe(true);
    expect(ent.features.backup).toBe(true);
    expect(ent.features.sshVault).toBe(true);
    expect(ent.features.teamApis).toBe(false);
    expect(ent.features.teamMemory).toBe(false);
    expect(ent.features.teamSshVault).toBe(false);
    expect(ent.limits.maxApiDocs).toBe(100);
  });
  it('team plan → team tier with shared features (incl. teamSshVault), no SSO', () => {
    const ent = deriveEntitlements(sub({ plan: 'team', status: 'active' }), NOW);
    expect(ent.tier).toBe('team');
    expect(ent.features.teamApis).toBe(true);
    expect(ent.features.teamMemory).toBe(true);
    expect(ent.features.teamTemplates).toBe(true);
    expect(ent.features.sshVault).toBe(true);
    expect(ent.features.teamSshVault).toBe(true);
    expect(ent.features.sso).toBe(false);
  });
  it('enterprise plan → SSO + audit export, unlimited shares', () => {
    const ent = deriveEntitlements(sub({ plan: 'enterprise', status: 'active' }), NOW);
    expect(ent.tier).toBe('enterprise');
    expect(ent.features.sso).toBe(true);
    expect(ent.features.auditExport).toBe(true);
    expect(ent.limits.maxActiveShares).toBe(-1);
  });
  it('a lapsed team subscription falls back to free (no team features)', () => {
    const ent = deriveEntitlements(sub({ plan: 'team', status: 'active', periodEndMs: NOW - 1 }), NOW);
    expect(ent.tier).toBe('free');
    expect(ent.features.teamApis).toBe(false);
  });
});

describe('GetEntitlementsUseCase (auto-trial on first touch)', () => {
  it('first cloud touch grants a 14-day trial → pro', async () => {
    const repo = new FakeBillingRepo();
    const ent = await new GetEntitlementsUseCase(repo, clock).execute({ accountId: acc });
    expect(ent.tier).toBe('pro');
    expect(ent.status).toBe('trialing');
    expect((await repo.getSubscription(acc))?.trialUsed).toBe(true);
  });
  it('does not re-grant a used trial → free once lapsed', async () => {
    const repo = new FakeBillingRepo();
    await repo.upsertSubscription(sub({ status: 'canceled', trialUsed: true }));
    const ent = await new GetEntitlementsUseCase(repo, clock).execute({ accountId: acc });
    expect(ent.tier).toBe('free');
  });
  it('existing active subscription → pro', async () => {
    const repo = new FakeBillingRepo();
    await repo.upsertSubscription(sub({ plan: 'pro', status: 'active', trialUsed: true }));
    const ent = await new GetEntitlementsUseCase(repo, clock).execute({ accountId: acc });
    expect(ent.tier).toBe('pro');
  });
});

describe('HandleSubscriptionEventUseCase (idempotent projection)', () => {
  const event: SubscriptionEvent = {
    eventId: 'evt_1',
    accountId: acc,
    plan: 'pro',
    status: 'active',
    periodEndMs: NOW + 86_400_000,
    stripeCustomerId: 'cus_1',
  };
  it('applies an event then dedupes the replay', async () => {
    const repo = new FakeBillingRepo();
    const uc = new HandleSubscriptionEventUseCase(repo);
    const first = await uc.execute(event);
    expect(first.applied).toBe(true);
    expect((await repo.getSubscription(acc))?.status).toBe('active');
    const replay = await uc.execute(event);
    expect(replay.applied).toBe(false); // idempotent
  });
});

describe('checkout / portal guards', () => {
  it('checkout returns billing_not_configured when Stripe is absent', async () => {
    const r = await new CreateCheckoutUseCase(new FakeGateway(false)).execute({ accountId: acc, email: 'u@e.com', plan: 'pro' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('billing_not_configured');
  });
  it('checkout returns a url when configured', async () => {
    const r = await new CreateCheckoutUseCase(new FakeGateway(true)).execute({ accountId: acc, email: 'u@e.com', plan: 'pro' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.url).toContain('checkout.stripe.test');
  });
  it('portal returns no_customer before any checkout', async () => {
    const repo = new FakeBillingRepo();
    const r = await new CreatePortalUseCase(new FakeGateway(true), repo).execute({ accountId: acc });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('no_customer');
  });
  it('portal returns a url once a stripe customer exists', async () => {
    const repo = new FakeBillingRepo();
    await repo.upsertSubscription(sub({ status: 'active', stripeCustomerId: 'cus_1' }));
    const r = await new CreatePortalUseCase(new FakeGateway(true), repo).execute({ accountId: acc });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.url).toContain('billing.stripe.test');
  });
});
