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
  ReconcileSubscriptionUseCase,
  pickActive,
  type BillingRepo,
  type CheckoutSession,
  type PaymentGateway,
  type Subscription,
  type SubscriptionEvent,
  type SubscriptionSnapshot,
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
  async setStripeCustomerId(accountId: AccountId, stripeCustomerId: string) {
    // UPDATE-only (mirrors the D1 repo): never creates a row, so the auto-trial
    // first-touch signal in GetEntitlements stays intact.
    const existing = this.store.get(accountId);
    if (existing) this.store.set(accountId, { ...existing, stripeCustomerId });
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
  ensured: { accountId: string; email: string }[] = [];
  constructor(
    public configured: boolean,
    private readonly opts: { subs?: SubscriptionSnapshot[]; customerByEmail?: string } = {},
  ) {}
  async createCheckout(): Promise<CheckoutSession> {
    return { url: 'https://checkout.stripe.test/c/1' };
  }
  async createPortal(): Promise<CheckoutSession> {
    return { url: 'https://billing.stripe.test/p/1' };
  }
  async parseWebhook(): Promise<SubscriptionEvent | null> {
    return null;
  }
  async ensureCustomer(input: { accountId: AccountId; email: string }) {
    this.ensured.push({ accountId: input.accountId, email: input.email });
    return { stripeCustomerId: 'cus_ensured' };
  }
  async findCustomerByEmail(_email: string) {
    return this.opts.customerByEmail ? { stripeCustomerId: this.opts.customerByEmail } : null;
  }
  async listSubscriptions(_stripeCustomerId: string) {
    return this.opts.subs ?? [];
  }
}

function snap(p: Partial<SubscriptionSnapshot>): SubscriptionSnapshot {
  return { plan: 'pro', status: 'active', periodEndMs: null, stripeCustomerId: 'cus_1', ...p };
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
    const r = await new CreateCheckoutUseCase(new FakeGateway(false), new FakeBillingRepo()).execute({ accountId: acc, email: 'u@e.com', plan: 'pro' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('billing_not_configured');
  });
  it('checkout ensures + persists the customer, then returns a url', async () => {
    const gw = new FakeGateway(true);
    const repo = new FakeBillingRepo();
    // A pre-existing (trial) row so the UPDATE-only setStripeCustomerId persists.
    await repo.upsertSubscription(sub({ plan: 'pro', status: 'trialing', trialUsed: true }));
    const r = await new CreateCheckoutUseCase(gw, repo).execute({ accountId: acc, email: 'u@e.com', plan: 'pro' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.url).toContain('checkout.stripe.test');
    expect(gw.ensured).toHaveLength(1); // customer was ensured up-front
    expect((await repo.getSubscription(acc))?.stripeCustomerId).toBe('cus_ensured'); // persisted for reconcile
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

describe('pickActive (reconciliation winner selection)', () => {
  it('returns null for an empty list (caller must leave D1 untouched)', () => {
    expect(pickActive([])).toBeNull();
  });
  it('returns null when nothing is live (only canceled/past_due)', () => {
    expect(pickActive([snap({ status: 'canceled' }), snap({ status: 'past_due' })])).toBeNull();
  });
  it('prefers active over trialing', () => {
    const winner = pickActive([snap({ status: 'trialing', periodEndMs: NOW + 999 }), snap({ status: 'active' })]);
    expect(winner?.status).toBe('active');
  });
  it('among same status, the later period end wins (null = unbounded beats finite)', () => {
    expect(pickActive([snap({ periodEndMs: NOW + 10 }), snap({ periodEndMs: NOW + 99 })])?.periodEndMs).toBe(NOW + 99);
    expect(pickActive([snap({ periodEndMs: NOW + 99 }), snap({ periodEndMs: null })])?.periodEndMs).toBeNull();
  });
});

describe('ReconcileSubscriptionUseCase (self-heal a missed webhook)', () => {
  it('returns billing_not_configured when Stripe is absent', async () => {
    const r = await new ReconcileSubscriptionUseCase(new FakeGateway(false), new FakeBillingRepo()).execute({ accountId: acc, email: 'u@e.com' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('billing_not_configured');
  });
  it('heals a lapsed-trial row that actually paid → active pro', async () => {
    const repo = new FakeBillingRepo();
    // D1 still shows the trial (webhook was dropped); Stripe says active.
    await repo.upsertSubscription(sub({ plan: 'pro', status: 'trialing', periodEndMs: NOW - 1, trialUsed: true, stripeCustomerId: 'cus_1' }));
    const gw = new FakeGateway(true, { subs: [snap({ status: 'active', periodEndMs: NOW + 86_400_000 })] });
    const r = await new ReconcileSubscriptionUseCase(gw, repo).execute({ accountId: acc, email: 'u@e.com' });
    expect(r.ok && r.value.applied).toBe(true);
    expect((await repo.getSubscription(acc))?.status).toBe('active');
  });
  it('NEVER wipes a paid row from an empty/transient Stripe read', async () => {
    const repo = new FakeBillingRepo();
    await repo.upsertSubscription(sub({ plan: 'pro', status: 'active', periodEndMs: NOW + 86_400_000, trialUsed: true, stripeCustomerId: 'cus_1' }));
    const gw = new FakeGateway(true, { subs: [] }); // transient empty read
    const r = await new ReconcileSubscriptionUseCase(gw, repo).execute({ accountId: acc, email: 'u@e.com' });
    expect(r.ok && r.value.applied).toBe(false);
    expect((await repo.getSubscription(acc))?.status).toBe('active'); // untouched
  });
  it('falls back to findCustomerByEmail when no local customer id', async () => {
    const repo = new FakeBillingRepo(); // no row at all
    const gw = new FakeGateway(true, { customerByEmail: 'cus_email', subs: [snap({ status: 'active', stripeCustomerId: 'cus_email' })] });
    const r = await new ReconcileSubscriptionUseCase(gw, repo).execute({ accountId: acc, email: 'u@e.com' });
    expect(r.ok && r.value.applied).toBe(true);
    expect((await repo.getSubscription(acc))?.stripeCustomerId).toBe('cus_email');
  });
  it('no customer anywhere → applied:false (no write)', async () => {
    const repo = new FakeBillingRepo();
    const gw = new FakeGateway(true, {}); // no local id, no customer by email
    const r = await new ReconcileSubscriptionUseCase(gw, repo).execute({ accountId: acc, email: 'u@e.com' });
    expect(r.ok && r.value.applied).toBe(false);
    expect(await repo.getSubscription(acc)).toBeNull();
  });
});
