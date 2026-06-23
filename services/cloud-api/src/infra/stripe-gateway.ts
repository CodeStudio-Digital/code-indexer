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
import type { CheckoutSession, PaymentGateway, PlanId, SubStatus, SubscriptionEvent } from '@cloudstudio/cloud-billing';

export interface StripeConfig {
  secretKey?: string;
  webhookSecret?: string;
  /** Stripe Price id for the Pro plan; required for live checkout. */
  proPriceId?: string;
  /** Stripe Price id for the per-seat Teams plan (quantity = writer seats). */
  teamsPriceId?: string;
  appBaseUrl: string;
  /** Tolerance for the webhook timestamp, ms. Default 5 min (Stripe's window). */
  toleranceMs?: number;
}

/** A verified org subscription change parsed from a Stripe webhook (the per-seat
 *  parallel to the personal `SubscriptionEvent`). */
export interface OrgSubscriptionEvent {
  eventId: string;
  orgId: string;
  plan: PlanId;
  status: SubStatus;
  seats: number;
  periodEndMs: number | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
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

// ── Org (per-seat Teams) billing — parallel to the personal port, kept here so
// all Stripe specifics live in one adapter. Reuses stripePost + the signature
// verifier. The org webhook is dispatched by the billing route after the personal
// parse returns null (the signature is verified there). ──────────────────────
export async function orgCheckout(
  cfg: StripeConfig,
  input: { orgId: string; email: string; seats: number; stripeCustomerId?: string | null },
): Promise<CheckoutSession> {
  const body = new URLSearchParams({
    mode: 'subscription',
    'line_items[0][price]': cfg.teamsPriceId ?? '',
    'line_items[0][quantity]': String(Math.max(1, input.seats)),
    client_reference_id: input.orgId,
    'subscription_data[metadata][orgId]': input.orgId,
    'metadata[orgId]': input.orgId,
    success_url: `${cfg.appBaseUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${cfg.appBaseUrl}/billing/cancel`,
  });
  if (input.stripeCustomerId) body.set('customer', input.stripeCustomerId);
  else body.set('customer_email', input.email);
  const session = await stripePost(cfg.secretKey!, '/checkout/sessions', body);
  return { url: String(session.url) };
}

export async function orgPortal(cfg: StripeConfig, stripeCustomerId: string): Promise<CheckoutSession> {
  const body = new URLSearchParams({ customer: stripeCustomerId, return_url: `${cfg.appBaseUrl}/billing` });
  const session = await stripePost(cfg.secretKey!, '/billing_portal/sessions', body);
  return { url: String(session.url) };
}

/** Map a (signature-verified) Stripe subscription event to an org change. Returns
 *  null unless it's a `customer.subscription.*` carrying `metadata.orgId`. Tier is
 *  read from the line-item price; seats from its quantity. */
export function mapOrgEvent(event: StripeEvent, teamsPriceId?: string): OrgSubscriptionEvent | null {
  if (!event.type.startsWith('customer.subscription.')) return null;
  const obj = event.data.object;
  const orgId = (obj.metadata as Record<string, string> | undefined)?.orgId;
  if (!orgId) return null;
  const status = mapStatus(String(obj.status ?? ''), event.type);
  const item = ((obj.items as { data?: Array<Record<string, unknown>> } | undefined)?.data ?? [])[0];
  const seats = item && typeof item.quantity === 'number' ? item.quantity : 1;
  // Today the only org price is Teams; an enterprise price id would branch here.
  void teamsPriceId;
  const plan: PlanId = status === 'active' || status === 'trialing' ? 'team' : 'free';
  const periodEnd = obj.current_period_end;
  return {
    eventId: event.id,
    orgId,
    plan,
    status,
    seats: Math.max(1, seats),
    periodEndMs: typeof periodEnd === 'number' ? periodEnd * 1000 : null,
    stripeCustomerId: typeof obj.customer === 'string' ? obj.customer : null,
    stripeSubscriptionId: typeof obj.id === 'string' ? obj.id : null,
  };
}

// ── Stripe REST (form-encoded; Bearer secret) ──────────────────────────────
export async function stripePost(secret: string, path: string, body: URLSearchParams): Promise<Record<string, unknown>> {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(10_000),
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
  // Stripe sends `t=...,v1=...,v1=...` (during key rotation there can be MORE THAN
  // ONE v1). Collect every v1 and accept if ANY matches. Split only on the FIRST
  // '=' so signature values are never truncated.
  let t = 0;
  const v1s: string[] = [];
  for (const kv of header.split(',')) {
    const i = kv.indexOf('=');
    if (i < 0) continue;
    const k = kv.slice(0, i);
    const v = kv.slice(i + 1);
    if (k === 't') t = Number(v);
    else if (k === 'v1') v1s.push(v);
  }
  if (!t || v1s.length === 0) return false;
  if (Math.abs(Date.now() - t * 1000) > toleranceMs) return false;
  const expected = await hmacSha256Hex(secret, `${t}.${payload}`);
  return v1s.some((v1) => timingSafeEqualHex(expected, v1));
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
export interface StripeEvent {
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
