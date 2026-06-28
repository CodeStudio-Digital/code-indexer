/**
 * Billing routes. entitlements/checkout/portal are Bearer-protected; the Stripe
 * webhook is NOT (it is verified by signature instead). The webhook reads the RAW
 * body — never a re-serialized JSON — so the HMAC matches.
 */
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { asAccountId, toErrorBody } from '@cloudstudio/cloud-kernel';
import { billingHttpStatus, type BillingError } from '@cloudstudio/cloud-billing';
import type { Env } from '../env.js';
import { createIdentityBundle } from '../composition.js';
import { createBillingBundle } from '../billing-composition.js';
import { resolveEntitlements } from '../entitlements.js';
import { WebhookSignatureError, mapOrgEvent, type StripeEvent } from '../infra/stripe-gateway.js';
import { createTeamsRepo } from '../infra/d1/teams-repo.js';
import { createD1Executor } from '../infra/d1/d1-executor.js';
import { requireClaims, unauthorized } from '../middleware/auth.js';
import { enforceRateLimit, HOUR } from '../middleware/rate-limit.js';
import { recordAudit } from '../middleware/audit.js';

function respondBillingError(c: Context<{ Bindings: Env }>, error: BillingError) {
  return c.json(toErrorBody(error), billingHttpStatus(error) as ContentfulStatusCode);
}

export function billingRouter(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  // Effective entitlements = personal (auto-grants the one-shot trial) ∪ orgs.
  app.get('/entitlements', async (c) => {
    const identity = createIdentityBundle(c.env);
    const claims = await requireClaims(c, identity);
    if (!claims) return unauthorized(c);
    const ent = await resolveEntitlements(c.env, claims.sub);
    return c.json(ent, 200);
  });

  // Hosted Stripe Checkout — returns a redirect URL (card surface stays on Stripe).
  app.post('/checkout', async (c) => {
    const identity = createIdentityBundle(c.env);
    const claims = await requireClaims(c, identity);
    if (!claims) return unauthorized(c);
    const account = await identity.accounts.findById(asAccountId(claims.sub));
    if (!account) return unauthorized(c);
    const r = await createBillingBundle(c.env).createCheckout.execute({
      accountId: asAccountId(claims.sub),
      email: account.email,
      plan: 'pro',
    });
    return r.ok ? c.json(r.value, 200) : respondBillingError(c, r.error);
  });

  // Stripe Customer Portal — manage/cancel an existing subscription.
  app.post('/portal', async (c) => {
    const identity = createIdentityBundle(c.env);
    const claims = await requireClaims(c, identity);
    if (!claims) return unauthorized(c);
    const r = await createBillingBundle(c.env).createPortal.execute({ accountId: asAccountId(claims.sub) });
    return r.ok ? c.json(r.value, 200) : respondBillingError(c, r.error);
  });

  // Reconcile from Stripe — self-heal a missed `checkout.session.completed` webhook.
  // The success page (and the desktop on window-focus) calls this so a paid user is
  // never stranded on the lapsing trial. Rate-limited: it makes live (billable)
  // Stripe reads, and it only ever UPGRADES (never downgrades) the local row.
  app.post('/sync', async (c) => {
    const identity = createIdentityBundle(c.env);
    const claims = await requireClaims(c, identity);
    if (!claims) return unauthorized(c);
    const limited = await enforceRateLimit(c, [{ key: `billingsync:${claims.sub}`, limit: 12, windowMs: HOUR }]);
    if (limited) return limited;
    const account = await identity.accounts.findById(asAccountId(claims.sub));
    if (!account) return unauthorized(c);
    const r = await createBillingBundle(c.env).reconcile.execute({ accountId: asAccountId(claims.sub), email: account.email });
    if (r.ok && r.value.applied) recordAudit(c, 'billing_reconciled', 200, { accountId: claims.sub });
    return r.ok ? c.json(r.value, 200) : respondBillingError(c, r.error);
  });

  // Stripe webhook sink — signature-verified, idempotent projection into D1.
  app.post('/webhook', async (c) => {
    const sig = c.req.header('stripe-signature') ?? '';
    const raw = await c.req.text();
    const bundle = createBillingBundle(c.env);
    let event;
    try {
      event = await bundle.gateway.parseWebhook(raw, sig);
    } catch (e) {
      if (e instanceof WebhookSignatureError) return c.json({ code: 'webhook_signature_invalid', message: 'Invalid signature.' }, 400);
      console.error('[billing] webhook parse failed', e);
      return c.json({ code: 'internal', message: 'Webhook error' }, 500);
    }
    if (!event) {
      // Not a personal event — it may be an ORG (per-seat) subscription event.
      // The signature was already verified above (parseWebhook didn't throw), so
      // re-reading the same raw payload for the org projection is safe.
      const orgEvent = mapOrgEvent(JSON.parse(raw) as StripeEvent, c.env.STRIPE_TEAMS_PRICE_ID);
      if (!orgEvent) return c.json({ received: true, ignored: true }, 200);
      const first = await bundle.billing.recordWebhookEvent(orgEvent.eventId); // shared idempotency table
      if (first) {
        await createTeamsRepo(createD1Executor(c.env.DB)).upsertSubscription({
          orgId: orgEvent.orgId,
          plan: orgEvent.plan,
          status: orgEvent.status,
          periodEndMs: orgEvent.periodEndMs,
          seats: orgEvent.seats,
          trialUsed: true,
          stripeCustomerId: orgEvent.stripeCustomerId,
          stripeSubscriptionId: orgEvent.stripeSubscriptionId,
        });
        recordAudit(c, 'org_billing_webhook_applied', 200, { orgId: orgEvent.orgId, status: orgEvent.status, seats: orgEvent.seats });
      }
      return c.json({ received: true, applied: first }, 200);
    }
    const r = await bundle.handleWebhook.execute(event);
    if (r.applied) recordAudit(c, 'billing_webhook_applied', 200, { accountId: event.accountId, status: event.status, plan: event.plan });
    return c.json({ received: true, applied: r.applied }, 200);
  });

  return app;
}
