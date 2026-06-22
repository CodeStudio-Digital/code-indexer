/**
 * Personal-sync routes. Both Bearer-protected and entitlement-gated (`sync`):
 *  - POST /v1/sync/push — upload changed documents; server reconciles (LWW) and
 *    returns per-doc status (applied|noop|conflict) + the new feed cursor.
 *  - POST /v1/sync/pull — download everything past the client's cursor.
 * The client strips secret ENV VALUES before pushing (structure-only sync); the
 * server never receives or stores secrets. Both are JSON.
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Env } from '../env.js';
import { createIdentityBundle } from '../composition.js';
import { createSyncBundle } from '../sync-composition.js';
import { resolveEntitlements } from '../entitlements.js';
import { requireClaims, unauthorized, isVerified, emailNotVerified } from '../middleware/auth.js';
import { enforceRateLimit, HOUR } from '../middleware/rate-limit.js';
import { SYNC_KINDS } from '../sync/types.js';

const kindSchema = z.enum(['collection', 'environment', 'memory', 'note', 'project']);

const pushItemSchema = z.object({
  kind: kindSchema,
  clientDocId: z.string().min(1).max(128),
  baseVersion: z.number().int().nonnegative().default(0),
  updatedAtMs: z.number().int().nonnegative(),
  deleted: z.boolean().optional(),
  body: z.unknown().optional(),
});
const pushSchema = z.object({ documents: z.array(pushItemSchema).max(500) });
const pullSchema = z.object({
  kinds: z.array(kindSchema).nonempty().optional(),
  sinceVersion: z.number().int().nonnegative().default(0),
});

function notEntitled(c: Context<{ Bindings: Env }>) {
  return c.json({ code: 'sync_not_entitled', message: 'Cloud sync requires an active subscription or trial.' }, 402);
}

export function syncRouter(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.post('/push', async (c) => {
    const parsed = pushSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ code: 'validation_failed', message: 'Invalid push payload.', details: parsed.error.flatten() }, 400);
    const claims = await requireClaims(c, createIdentityBundle(c.env));
    if (!claims) return unauthorized(c);
    if (!isVerified(claims)) return emailNotVerified(c);
    const limited = await enforceRateLimit(c, [{ key: `sync:acct:${claims.sub}`, limit: 240, windowMs: HOUR }]);
    if (limited) return limited;
    const bundle = createSyncBundle(c.env, claims.sub);
    const ent = await resolveEntitlements(c.env, claims.sub);
    if (!ent.features.sync) return notEntitled(c);
    const out = await bundle.service.push(parsed.data.documents);
    return c.json(out, 200);
  });

  app.post('/pull', async (c) => {
    const parsed = pullSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ code: 'validation_failed', message: 'Invalid pull payload.', details: parsed.error.flatten() }, 400);
    const claims = await requireClaims(c, createIdentityBundle(c.env));
    if (!claims) return unauthorized(c);
    const bundle = createSyncBundle(c.env, claims.sub);
    const ent = await resolveEntitlements(c.env, claims.sub);
    if (!ent.features.sync) return notEntitled(c);
    const out = await bundle.service.pull(parsed.data.kinds ?? SYNC_KINDS, parsed.data.sinceVersion);
    return c.json(out, 200);
  });

  return app;
}
