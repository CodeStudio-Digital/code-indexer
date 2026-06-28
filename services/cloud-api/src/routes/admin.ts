/**
 * Platform-operator surface (/v1/admin). Today: sales-led Enterprise fulfilment —
 * there is no self-serve Enterprise checkout, so after a signed contract an
 * operator grants the org the Enterprise (or Team) plan here. Authed by a single
 * bearer token (ADMIN_API_TOKEN, set via `wrangler secret put`); absent ⇒ the whole
 * router 404s (fail-soft, mirroring how OAuth/Stripe/Turnstile degrade). This is an
 * OPS token, NOT a user role — there is no admin concept for regular accounts.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../env.js';
import { createTeamsRepo } from '../infra/d1/teams-repo.js';
import { createD1Executor } from '../infra/d1/d1-executor.js';
import { recordAuditNow } from '../middleware/audit.js';

const planSchema = z.object({
  plan: z.enum(['free', 'team', 'enterprise']),
  status: z.enum(['active', 'trialing', 'past_due', 'canceled', 'none']).optional(),
  seats: z.number().int().min(0).max(10_000_000).optional(),
  periodEndMs: z.number().int().nullable().optional(),
});

/** Constant-time string compare (avoid leaking the token length-prefix via timing). */
function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function adminRouter(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.use('*', async (c, next) => {
    const expected = c.env.ADMIN_API_TOKEN;
    if (!expected || expected.length < 16) return c.json({ code: 'not_found', message: 'Not found' }, 404);
    const auth = c.req.header('authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token || !timingSafeEqualStr(token, expected)) {
      return c.json({ code: 'unauthorized', message: 'Unauthorized.' }, 401);
    }
    return next();
  });

  // Grant/adjust an ORG plan. Enterprise/Team are org-level (a personal
  // subscription only ever carries free/pro). 'free' revokes. Audited synchronously.
  app.post('/orgs/:orgId/plan', async (c) => {
    const parsed = planSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ code: 'validation_failed', message: 'Invalid plan.' }, 400);
    const orgId = c.req.param('orgId');
    const teams = createTeamsRepo(createD1Executor(c.env.DB));
    const org = await teams.getOrg(orgId);
    if (!org) return c.json({ code: 'org_not_found', message: 'Organization not found.' }, 404);
    const existing = await teams.getSubscription(orgId);
    const plan = parsed.data.plan;
    // Enterprise = unlimited seats (entitlements maxSeats = -1). Seat ENFORCEMENT in
    // teams/service.ts reads org_subscriptions.seats directly, so grant a high cap.
    const seats = parsed.data.seats ?? (plan === 'enterprise' ? 1_000_000 : (existing?.seats ?? 1));
    await teams.upsertSubscription({
      orgId,
      plan,
      status: parsed.data.status ?? (plan === 'free' ? 'canceled' : 'active'),
      periodEndMs: parsed.data.periodEndMs ?? null,
      seats,
      trialUsed: existing?.trialUsed ?? true,
      stripeCustomerId: existing?.stripeCustomerId ?? null,
      stripeSubscriptionId: existing?.stripeSubscriptionId ?? null,
    });
    await recordAuditNow(c, 'admin_org_plan_set', 200, { orgId, plan, seats });
    return c.json({ ok: true, orgId, plan, seats }, 200);
  });

  return app;
}
