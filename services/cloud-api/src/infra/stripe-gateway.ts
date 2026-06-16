/**
 * Stripe adapter for the billing PaymentGateway port. Everything Stripe-specific
 * lives here; the use-cases see only the provider-neutral port. Swapping to
 * Paddle/LemonSqueezy later is a second adapter, no use-case change.
 *
 * `configured` is false when the secret/webhook keys are absent (local dev) — the
 * routes then return 501 instead of calling a half-wired Stripe. The webhook
 * signature verification (`parseWebhook`) is hand-rolled over WebCrypto HMAC so
 * it is fully unit-testable without the Stripe SDK or a live account.
 */
import { asAccountId } from '@cloudstudio/cloud-kernel';
import type { PaymentGateway, PlanId, SubStatus, SubscriptionEvent } from '@cloudstudio/cloud-billing';

export interface StripeConfig {
  secretKey?: string;
  webhookSecret?: string;
  /** Stripe Price id for the Pro plan; required for live checkout. */
  proPriceId?: string;
  appBaseUrl: string;
  /** Tolerance for the webhook timestamp, ms. Default 5 min (Stripe's window). */
  toleranceMs?: number;
}

const STRIPE_API = 'https://api.stripe.com/v1';

export function createStripeGateway(cfg: StripeConfig): PaymentGateway {
  const configured = !!(cfg.secretKey && cfg.webhookSecret);
  const tolerance = cfg.toleranceMs ?? 5 * 60 * 1000;

  return {
    configured,

    async createCheckout({ accountId, email, plan }) {
      const body = new URLSearchParams({
        mode: 'subscription',
        'line_items[0][price]': cfg.proPriceId ?? '',
        'line_items[0][quantity]': '1',
        customer_email: email,
        client_reference_id: accountId,
        'subscription_data[metadata][accountId]': accountId,
        'metadata[accountId]': accountId,
        'metadata[plan]': plan,
        success_url: `${cfg.appBaseUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${cfg.appBaseUrl}/billing/cancel`,
      });
      const session = await stripePost(cfg.secretKey!, '/checkout/sessions', body);
      return { url: String(session.url) };
    },

    async createPortal({ stripeCustomerId }) {
      const body = new URLSearchParams({
        customer: stripeCustomerId,
        return_url: `${cfg.appBaseUrl}/billing`,
      });
      const session = await stripePost(cfg.secretKey!, '/billing_portal/sessions', body);
      return { url: String(session.url) };
    },

    async parseWebhook(rawBody, signature) {
      const verified = await verifyStripeSignature(rawBody, signature, cfg.webhookSecret ?? '', tolerance);
      if (!verified) throw new WebhookSignatureError();
      const event = JSON.parse(rawBody) as StripeEvent;
      return mapEvent(event);
    },
  };
}

/** Thrown by parseWebhook on a bad signature; the route maps it to 400. */
export class WebhookSignatureError extends Error {
  constructor() {
    super('invalid_webhook_signature');
    this.name = 'WebhookSignatureError';
  }
}

// ── Stripe REST (form-encoded; Bearer secret) ──────────────────────────────
async function stripePost(secret: string, path: string, body: URLSearchParams): Promise<Record<string, unknown>> {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`stripe_${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

// ── Webhook signature verification (Stripe `t=…,v1=…` scheme over WebCrypto) ─
export async function verifyStripeSignature(
  payload: string,
  header: string,
  secret: string,
  toleranceMs: number,
): Promise<boolean> {
  if (!secret) return false;
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=') as [string, string]));
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!t || !v1) return false;
  if (Math.abs(Date.now() - t * 1000) > toleranceMs) return false;
  const expected = await hmacSha256Hex(secret, `${t}.${payload}`);
  return timingSafeEqualHex(expected, v1);
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── Event → provider-neutral SubscriptionEvent ─────────────────────────────
interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

function mapEvent(event: StripeEvent): SubscriptionEvent | null {
  if (!event.type.startsWith('customer.subscription.')) return null; // ignore others
  const obj = event.data.object;
  const accountId = (obj.metadata as Record<string, string> | undefined)?.accountId;
  if (!accountId) return null;
  const stripeStatus = String(obj.status ?? '');
  const status = mapStatus(stripeStatus, event.type);
  const plan: PlanId = status === 'active' || status === 'trialing' ? 'pro' : 'free';
  const periodEnd = obj.current_period_end;
  return {
    eventId: event.id,
    accountId: asAccountId(accountId),
    plan,
    status,
    periodEndMs: typeof periodEnd === 'number' ? periodEnd * 1000 : null,
    stripeCustomerId: typeof obj.customer === 'string' ? obj.customer : null,
  };
}

function mapStatus(stripeStatus: string, eventType: string): SubStatus {
  if (eventType === 'customer.subscription.deleted') return 'canceled';
  switch (stripeStatus) {
    case 'trialing':
      return 'trialing';
    case 'active':
      return 'active';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'canceled':
    case 'incomplete_expired':
      return 'canceled';
    default:
      return 'none';
  }
}
