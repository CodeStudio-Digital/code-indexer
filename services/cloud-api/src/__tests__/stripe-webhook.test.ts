/**
 * Stripe webhook signature verification + event mapping. The HMAC is verified
 * with WebCrypto inside the gateway; here we generate the expected signature with
 * node:crypto (an independent implementation) so a passing test cross-checks both.
 * No live Stripe / SDK needed — parseWebhook never calls fetch on the webhook path.
 */
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  createStripeGateway,
  verifyStripeSignature,
  WebhookSignatureError,
  mapOrgEvent,
  mapSubscriptionFields,
  buildCheckoutParams,
  type StripeEvent,
} from '../infra/stripe-gateway.js';

const SECRET = 'whsec_test_secret';
const sign = (t: number, payload: string) => createHmac('sha256', SECRET).update(`${t}.${payload}`).digest('hex');
const header = (t: number, payload: string) => `t=${t},v1=${sign(t, payload)}`;

function subEvent(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'evt_1',
    type: 'customer.subscription.created',
    data: {
      object: {
        status: 'active',
        current_period_end: 1_800_000_000, // seconds
        customer: 'cus_1',
        metadata: { accountId: 'acc1' },
        ...overrides,
      },
    },
  });
}

function gateway() {
  return createStripeGateway({ secretKey: 'sk_test', webhookSecret: SECRET, appBaseUrl: 'https://app.test' });
}

describe('verifyStripeSignature', () => {
  it('accepts a fresh, correctly-signed payload', async () => {
    const t = Math.floor(Date.now() / 1000);
    const payload = subEvent();
    expect(await verifyStripeSignature(payload, header(t, payload), SECRET, 5 * 60 * 1000)).toBe(true);
  });
  it('rejects a tampered signature', async () => {
    const t = Math.floor(Date.now() / 1000);
    const payload = subEvent();
    const bad = `t=${t},v1=${'0'.repeat(64)}`;
    expect(await verifyStripeSignature(payload, bad, SECRET, 5 * 60 * 1000)).toBe(false);
  });
  it('accepts when ANY of multiple v1 signatures matches (key rotation)', async () => {
    const t = Math.floor(Date.now() / 1000);
    const payload = subEvent();
    // Stripe emits several v1 during a secret rotation; one of them is ours.
    const multi = `t=${t},v1=${'0'.repeat(64)},v1=${sign(t, payload)}`;
    expect(await verifyStripeSignature(payload, multi, SECRET, 5 * 60 * 1000)).toBe(true);
  });
  it('does not truncate a scheme containing extra "=" segments', async () => {
    const t = Math.floor(Date.now() / 1000);
    const payload = subEvent();
    // A future scheme value with '=' must not break the split-on-first-'=' parse.
    const withEq = `t=${t},v0=ab=cd,v1=${sign(t, payload)}`;
    expect(await verifyStripeSignature(payload, withEq, SECRET, 5 * 60 * 1000)).toBe(true);
  });
  it('rejects a stale timestamp outside tolerance', async () => {
    const t = Math.floor(Date.now() / 1000) - 3600; // 1h old
    const payload = subEvent();
    expect(await verifyStripeSignature(payload, header(t, payload), SECRET, 5 * 60 * 1000)).toBe(false);
  });
  it('rejects when the secret is empty', async () => {
    const t = Math.floor(Date.now() / 1000);
    const payload = subEvent();
    expect(await verifyStripeSignature(payload, header(t, payload), '', 5 * 60 * 1000)).toBe(false);
  });
});

describe('parseWebhook (mapping + guards)', () => {
  it('maps a verified customer.subscription.created → SubscriptionEvent', async () => {
    const t = Math.floor(Date.now() / 1000);
    const payload = subEvent();
    const event = await gateway().parseWebhook(payload, header(t, payload));
    expect(event).not.toBeNull();
    expect(event!.eventId).toBe('evt_1');
    expect(event!.accountId).toBe('acc1');
    expect(event!.plan).toBe('pro');
    expect(event!.status).toBe('active');
    expect(event!.periodEndMs).toBe(1_800_000_000 * 1000);
    expect(event!.stripeCustomerId).toBe('cus_1');
  });
  it('throws WebhookSignatureError on a bad signature', async () => {
    const t = Math.floor(Date.now() / 1000);
    const payload = subEvent();
    await expect(gateway().parseWebhook(payload, `t=${t},v1=deadbeef`)).rejects.toBeInstanceOf(WebhookSignatureError);
  });
  it('ignores non-subscription events (returns null)', async () => {
    const t = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({ id: 'evt_2', type: 'invoice.paid', data: { object: {} } });
    expect(await gateway().parseWebhook(payload, header(t, payload))).toBeNull();
  });
  it('deleted subscription maps to canceled', async () => {
    const t = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({
      id: 'evt_3',
      type: 'customer.subscription.deleted',
      data: { object: { status: 'canceled', customer: 'cus_1', metadata: { accountId: 'acc1' } } },
    });
    const event = await gateway().parseWebhook(payload, header(t, payload));
    expect(event!.status).toBe('canceled');
    expect(event!.plan).toBe('free');
  });
});

describe('mapOrgEvent (per-seat org projection)', () => {
  const orgEvt = (over: Record<string, unknown> = {}): StripeEvent => ({
    id: 'evt_org_1',
    type: 'customer.subscription.created',
    data: {
      object: {
        status: 'active',
        current_period_end: 1_800_000_000,
        customer: 'cus_org',
        id: 'sub_org',
        metadata: { orgId: 'org-1' },
        items: { data: [{ price: { id: 'price_teams' }, quantity: 7 }] },
        ...over,
      },
    },
  });
  it('maps an org subscription with seats from the line-item quantity', () => {
    const e = mapOrgEvent(orgEvt(), 'price_teams')!;
    expect(e.orgId).toBe('org-1');
    expect(e.plan).toBe('team');
    expect(e.seats).toBe(7);
    expect(e.status).toBe('active');
    expect(e.stripeSubscriptionId).toBe('sub_org');
    expect(e.periodEndMs).toBe(1_800_000_000 * 1000);
  });
  it('returns null for a personal event (no orgId)', () => {
    expect(mapOrgEvent({ id: 'e', type: 'customer.subscription.created', data: { object: { metadata: { accountId: 'a' } } } })).toBeNull();
  });
  it('returns null for non-subscription events', () => {
    expect(mapOrgEvent({ id: 'e', type: 'invoice.paid', data: { object: { metadata: { orgId: 'org-1' } } } })).toBeNull();
  });
  it('canceled subscription → free', () => {
    const e = mapOrgEvent(orgEvt({ status: 'canceled' }) as StripeEvent)!;
    expect(e.plan).toBe('free');
    expect(e.status).toBe('canceled');
  });
});

describe('projection parity (webhook ↔ reconcile share mapSubscriptionFields)', () => {
  it('the webhook event and the reconcile snapshot agree on plan/status/period/customer', async () => {
    const t = Math.floor(Date.now() / 1000);
    const obj = { status: 'active', current_period_end: 1_800_000_000, customer: 'cus_1', metadata: { accountId: 'acc1' } };
    const payload = JSON.stringify({ id: 'evt_x', type: 'customer.subscription.updated', data: { object: obj } });
    const event = (await gateway().parseWebhook(payload, header(t, payload)))!;
    const snapshot = mapSubscriptionFields(obj, 'customer.subscription.updated');
    expect({ plan: event.plan, status: event.status, periodEndMs: event.periodEndMs, stripeCustomerId: event.stripeCustomerId }).toEqual(snapshot);
  });
});

describe('buildCheckoutParams (return base lands on the portal, never the bare app)', () => {
  it('success/cancel use portalBaseUrl when set; email when no saved customer', () => {
    const params = buildCheckoutParams(
      { appBaseUrl: 'https://app.test', portalBaseUrl: 'https://account.test' },
      { accountId: 'acc1', email: 'u@e.com', plan: 'pro' },
    );
    expect(params.get('success_url')).toBe('https://account.test/billing/success?session_id={CHECKOUT_SESSION_ID}');
    expect(params.get('cancel_url')).toBe('https://account.test/billing/cancel');
    expect(params.get('customer_email')).toBe('u@e.com');
  });
  it('uses a saved customer id over the email when present', () => {
    const params = buildCheckoutParams(
      { appBaseUrl: 'https://app.test', portalBaseUrl: 'https://account.test' },
      { accountId: 'acc1', email: 'u@e.com', plan: 'pro', stripeCustomerId: 'cus_9' },
    );
    expect(params.get('customer')).toBe('cus_9');
    expect(params.get('customer_email')).toBeNull();
  });
  it('falls back to appBaseUrl only when no portal base configured', () => {
    const params = buildCheckoutParams({ appBaseUrl: 'https://app.test' }, { accountId: 'acc1', email: 'u@e.com', plan: 'pro' });
    expect(params.get('success_url')).toContain('https://app.test/billing/success');
  });
});

describe('gateway configured flag', () => {
  it('is false without keys (routes 501)', () => {
    expect(createStripeGateway({ appBaseUrl: 'https://app.test' }).configured).toBe(false);
  });
  it('is true with secret + webhook secret', () => {
    expect(gateway().configured).toBe(true);
  });
});
