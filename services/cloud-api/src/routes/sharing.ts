/**
 * Sharing routes. Create/list/revoke are Bearer-protected; the public viewer
 * (`GET /s/:slug`) takes NO auth. The create body schema FORBIDS base64 / raw
 * tool_result bodies by construction (fail-closed at the type level), and the
 * use-case re-redacts server-side before signing + storing.
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { asAccountId, asShareId, toErrorBody } from '@cloudstudio/cloud-kernel';
import { shareHttpStatus, isSlug, asSlug, type ShareError } from '@cloudstudio/cloud-sharing';
import type { Env } from '../env.js';
import { createIdentityBundle } from '../composition.js';
import { createSharingBundle } from '../sharing-composition.js';
import { requireClaims, unauthorized, isVerified, emailNotVerified } from '../middleware/auth.js';
import { enforceRateLimit, HOUR } from '../middleware/rate-limit.js';
import { recordAudit } from '../middleware/audit.js';

const blockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().max(100_000) }),
  z.object({ type: z.literal('tool_use'), name: z.string().max(64), inputSummary: z.string().max(4000) }),
  z.object({ type: z.literal('tool_result'), toolName: z.string().max(64), status: z.enum(['ok', 'error']), redacted: z.literal(true) }),
  z.object({ type: z.literal('image'), redacted: z.literal(true) }),
  z.object({ type: z.literal('document'), name: z.string().max(255).nullable(), redacted: z.literal(true) }),
]);
const snapshotSchema = z.object({
  schemaVersion: z.literal(1),
  title: z.string().min(1).max(200),
  model: z.string().max(120).nullable(),
  createdAtMs: z.number().int().nonnegative(),
  messages: z
    .array(z.object({ idx: z.number().int().nonnegative(), role: z.enum(['user', 'assistant']), blocks: z.array(blockSchema).max(500) }))
    .max(2000),
});
const createSchema = z.object({
  snapshot: snapshotSchema,
  visibility: z.enum(['public', 'unlisted']).default('unlisted'),
  expiresInDays: z.number().int().min(1).max(365).nullable().default(null),
});

function respondShareError(c: Context<{ Bindings: Env }>, error: ShareError) {
  return c.json(toErrorBody(error), shareHttpStatus(error) as ContentfulStatusCode);
}

export function sharingRouter(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.post('/', async (c) => {
    const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ code: 'validation_failed', message: 'Invalid snapshot.', details: parsed.error.flatten() }, 400);
    const claims = await requireClaims(c, createIdentityBundle(c.env));
    if (!claims) return unauthorized(c);
    if (!isVerified(claims)) return emailNotVerified(c);
    // Publishing signs + stores a snapshot (CPU + storage) — cap per account.
    const limited = await enforceRateLimit(c, [{ key: `share:acct:${claims.sub}`, limit: 30, windowMs: HOUR }]);
    if (limited) return limited;
    const sharing = createSharingBundle(c.env);
    if (!sharing.signerConfigured) return c.json({ code: 'sharing_not_configured', message: 'Sharing is not configured.' }, 501);
    const accountId = asAccountId(claims.sub);
    const ent = await sharing.getEntitlements.execute({ accountId });
    const r = await sharing.createShare.execute({
      ownerAccountId: accountId,
      snapshot: parsed.data.snapshot,
      visibility: parsed.data.visibility,
      expiresInDays: parsed.data.expiresInDays,
      entitlement: { sharing: ent.features.sharing, maxActiveShares: ent.limits.maxActiveShares },
    });
    if (!r.ok) return respondShareError(c, r.error);
    recordAudit(c, 'share_created', 201, { accountId, shareId: r.value.shareId, visibility: parsed.data.visibility });
    return c.json({ ...r.value, url: `${c.env.SHARE_BASE_URL}/s/${r.value.slug}` }, 201);
  });

  app.get('/', async (c) => {
    const claims = await requireClaims(c, createIdentityBundle(c.env));
    if (!claims) return unauthorized(c);
    const shares = await createSharingBundle(c.env).list.execute({ ownerAccountId: asAccountId(claims.sub) });
    return c.json({ shares: shares.map(toSummary) }, 200);
  });

  app.delete('/:id', async (c) => {
    const claims = await requireClaims(c, createIdentityBundle(c.env));
    if (!claims) return unauthorized(c);
    if (!isVerified(claims)) return emailNotVerified(c); // revoke is a cloud WRITE (R3)
    const r = await createSharingBundle(c.env).revoke.execute({ shareId: asShareId(c.req.param('id')), ownerAccountId: asAccountId(claims.sub) });
    if (r.ok) recordAudit(c, 'share_revoked', 200, { accountId: claims.sub, shareId: c.req.param('id') });
    return r.ok ? c.json(r.value, 200) : respondShareError(c, r.error);
  });

  return app;
}

/** Public read-only viewer data. NO auth. Mounted at top-level `/s/:slug`. */
export function publicShareRouter(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.get('/:slug', async (c) => {
    const slug = c.req.param('slug');
    if (!isSlug(slug)) return c.json(toErrorBody({ code: 'share_not_found', message: 'Share not found.' }), 404);
    const r = await createSharingBundle(c.env).getPublic.execute({ slug: asSlug(slug) });
    if (!r.ok) return respondShareError(c, r.error);
    return c.json(r.value, 200, { 'cache-control': 'public, max-age=60' });
  });
  return app;
}

function toSummary(s: { id: string; slug: string; title: string; visibility: string; status: string; messageCount: number; createdAtMs: number; expiresAtMs: number | null }) {
  return { id: s.id, slug: s.slug, title: s.title, visibility: s.visibility, status: s.status, messageCount: s.messageCount, createdAtMs: s.createdAtMs, expiresAtMs: s.expiresAtMs };
}
