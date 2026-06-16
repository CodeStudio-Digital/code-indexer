/**
 * TOTP 2FA routes. enroll/confirm/disable are Bearer-protected (manage your own
 * 2FA); challenge is NOT (it is gated by the short-lived challenge token from a
 * password-verified login that returned `twofa_required`).
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { asAccountId } from '@cloudstudio/cloud-kernel';
import type { Env } from '../env.js';
import { createIdentityBundle } from '../composition.js';
import { requireClaims, unauthorized } from '../middleware/auth.js';
import { respondError } from './_respond.js';
import { sha256Hex } from '../infra/sha256.js';

const codeSchema = z.object({ code: z.string().min(1).max(32) });
const challengeSchema = z.object({
  challengeToken: z.string().min(1).max(4096),
  code: z.string().min(1).max(32),
});

export function twoFactorRouter(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.post('/2fa/enroll', async (c) => {
    const bundle = createIdentityBundle(c.env);
    const claims = await requireClaims(c, bundle);
    if (!claims) return unauthorized(c);
    const account = await bundle.accounts.findById(asAccountId(claims.sub));
    if (!account) return unauthorized(c);
    const r = await bundle.enroll2fa.execute({ accountId: asAccountId(claims.sub), accountLabel: account.email });
    return r.ok ? c.json(r.value, 200) : respondError(c, r.error);
  });

  app.post('/2fa/confirm', async (c) => {
    const parsed = codeSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ code: 'validation_failed', message: 'Invalid input.' }, 400);
    const bundle = createIdentityBundle(c.env);
    const claims = await requireClaims(c, bundle);
    if (!claims) return unauthorized(c);
    const r = await bundle.confirm2fa.execute({ accountId: asAccountId(claims.sub), code: parsed.data.code });
    return r.ok ? c.json(r.value, 200) : respondError(c, r.error);
  });

  app.post('/2fa/disable', async (c) => {
    const parsed = codeSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ code: 'validation_failed', message: 'Invalid input.' }, 400);
    const bundle = createIdentityBundle(c.env);
    const claims = await requireClaims(c, bundle);
    if (!claims) return unauthorized(c);
    const r = await bundle.disable2fa.execute({ accountId: asAccountId(claims.sub), code: parsed.data.code });
    return r.ok ? c.json(r.value, 200) : respondError(c, r.error);
  });

  app.post('/2fa/challenge', async (c) => {
    const parsed = challengeSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ code: 'validation_failed', message: 'Invalid input.' }, 400);
    const ip = c.req.header('cf-connecting-ip') ?? null;
    const r = await createIdentityBundle(c.env).challenge2fa.execute({
      challengeToken: parsed.data.challengeToken,
      code: parsed.data.code,
      userAgent: c.req.header('user-agent') ?? null,
      ipHash: ip ? await sha256Hex(ip) : null,
    });
    return r.ok ? c.json(r.value, 200) : respondError(c, r.error);
  });

  return app;
}
