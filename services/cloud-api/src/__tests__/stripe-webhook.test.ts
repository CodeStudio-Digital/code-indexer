/**
 * Stripe webhook signature verification + event mapping. The HMAC is verified
 * with WebCrypto inside the gateway; here we generate the expected signature with
 * node:crypto (an independent implementation) so a passing test cross-checks both.
 * No live Stripe / SDK needed — parseWebhook never calls fetch on the webhook path.
 */
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { createStripeGateway, verifyStripeSignature, WebhookSignatureError } from '../infra/stripe-gateway.js';

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

describe('gateway configured flag', () => {
  it('is false without keys (routes 501)', () => {
    expect(createStripeGateway({ appBaseUrl: 'https://app.test' }).configured).toBe(false);
  });
  it('is true with secret + webhook secret', () => {
    expect(gateway().configured).toBe(true);
  });
});
