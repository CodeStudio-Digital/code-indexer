/**
 * Feedback routes. Submit is OPTIONAL-auth (a logged-in user is attributed; an
 * anonymous user must pass Turnstile). Attachment upload + list-own require auth.
 * Attachments are Worker-proxied (sniffed before R2). Admin triage is deferred.
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { asAccountId, toErrorBody } from '@cloudstudio/cloud-kernel';
import { feedbackHttpStatus, type FeedbackError } from '@cloudstudio/cloud-feedback';
import type { Env } from '../env.js';
import { createIdentityBundle } from '../composition.js';
import { createFeedbackBundle } from '../feedback-composition.js';
import { requireClaims, unauthorized } from '../middleware/auth.js';
import { enforceRateLimit, HOUR, DAY } from '../middleware/rate-limit.js';
import { recordAudit } from '../middleware/audit.js';
import { hashPii } from '../infra/sha256.js';

const submitSchema = z.object({
  kind: z.enum(['bug', 'idea', 'other']),
  message: z.string().trim().min(1).max(4000),
  appVersion: z.string().max(32).optional(),
  os: z.string().max(64).optional(),
  sessionShareId: z.string().max(64).optional(),
  attachmentIds: z.array(z.string().max(64)).max(3).optional(),
  contactEmail: z.string().email().max(254).optional(),
  turnstileToken: z.string().max(4096).optional(),
});

function respondFeedbackError(c: Context<{ Bindings: Env }>, error: FeedbackError) {
  return c.json(toErrorBody(error), feedbackHttpStatus(error) as ContentfulStatusCode);
}

export function feedbackRouter(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.post('/', async (c) => {
    const parsed = submitSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ code: 'feedback_validation', message: 'Invalid feedback.', details: parsed.error.flatten() }, 400);
    const claims = await requireClaims(c, createIdentityBundle(c.env)); // null ⇒ anonymous
    const ip = c.req.header('cf-connecting-ip') ?? null;
    const ipHash = ip ? await hashPii(ip, c.env.IP_HASH_SALT ?? '') : null;
    // Fail closed: an anonymous request with NO source IP cannot be rate-limited,
    // so we refuse it rather than let it bypass the per-IP cap (a logged-in caller
    // is bounded by the per-account key instead).
    if (!claims && !ipHash) {
      return c.json({ code: 'feedback_rate_limited', message: 'Could not verify the request source.' }, 429);
    }
    // Authed: 20/day/account. Anonymous: 3/hour/IP (Turnstile is the primary gate).
    const rule = claims
      ? { key: `feedback:acct:${claims.sub}`, limit: 20, windowMs: DAY }
      : { key: `feedback:ip:${ipHash}`, limit: 3, windowMs: HOUR };
    const limited = await enforceRateLimit(c, [rule]);
    if (limited) return limited;
    const d = parsed.data;
    const r = await createFeedbackBundle(c.env).submit.execute({
      kind: d.kind,
      message: d.message,
      accountId: claims ? asAccountId(claims.sub) : null,
      turnstileToken: d.turnstileToken ?? null,
      ip,
      ipHash,
      emailHash: d.contactEmail ? await hashPii(d.contactEmail.toLowerCase(), c.env.IP_HASH_SALT ?? '') : null,
      appVersion: d.appVersion ?? null,
      os: d.os ?? null,
      sessionShareId: d.sessionShareId ?? null,
      attachmentIds: d.attachmentIds ?? [],
    });
    if (r.ok) {
      recordAudit(c, 'feedback_submitted', 201, { accountId: claims ? claims.sub : null, kind: d.kind });
      return c.json(r.value, 201);
    }
    return respondFeedbackError(c, r.error);
  });

  app.post('/attachment', async (c) => {
    const claims = await requireClaims(c, createIdentityBundle(c.env));
    if (!claims) return unauthorized(c);
    const limited = await enforceRateLimit(c, [{ key: `feedback:attach:${claims.sub}`, limit: 10, windowMs: HOUR }]);
    if (limited) return limited;
    const bytes = await c.req.arrayBuffer();
    const r = await createFeedbackBundle(c.env).createAttachment.execute({ accountId: asAccountId(claims.sub), bytes });
    return r.ok ? c.json(r.value, 201) : respondFeedbackError(c, r.error);
  });

  app.get('/', async (c) => {
    const claims = await requireClaims(c, createIdentityBundle(c.env));
    if (!claims) return unauthorized(c);
    const items = await createFeedbackBundle(c.env).list.execute({ accountId: asAccountId(claims.sub) });
    return c.json({ items }, 200);
  });

  return app;
}
