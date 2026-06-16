/**
 * Email verification + password reset routes. request-password-reset ALWAYS
 * returns 200 (no account enumeration). resend-verification is Bearer-protected.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { asAccountId } from '@cloudstudio/cloud-kernel';
import type { Env } from '../env.js';
import { createIdentityBundle } from '../composition.js';
import { requireClaims, unauthorized } from '../middleware/auth.js';
import { respondError } from './_respond.js';

const tokenSchema = z.object({ token: z.string().min(1).max(4096) });
const requestResetSchema = z.object({ email: z.string().min(3).max(320) });
const resetSchema = z.object({ token: z.string().min(1).max(4096), password: z.string().min(1).max(512) });

export function emailRouter(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.post('/verify-email', async (c) => {
    const parsed = tokenSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ code: 'validation_failed', message: 'Invalid input.' }, 400);
    const r = await createIdentityBundle(c.env).verifyEmail.execute({ token: parsed.data.token });
    return r.ok ? c.json({ ok: true }, 200) : respondError(c, r.error);
  });

  app.post('/resend-verification', async (c) => {
    const bundle = createIdentityBundle(c.env);
    const claims = await requireClaims(c, bundle);
    if (!claims) return unauthorized(c);
    const account = await bundle.accounts.findById(asAccountId(claims.sub));
    if (!account) return unauthorized(c);
    if (account.isEmailVerified) return c.json({ ok: true, alreadyVerified: true }, 200);
    await bundle.sendVerification.execute({ accountId: asAccountId(claims.sub), email: account.email });
    return c.json({ ok: true }, 200);
  });

  app.post('/request-password-reset', async (c) => {
    const parsed = requestResetSchema.safeParse(await c.req.json().catch(() => ({})));
    if (parsed.success) {
      await createIdentityBundle(c.env).requestPasswordReset.execute({ emailRaw: parsed.data.email });
    }
    return c.json({ ok: true }, 200); // never reveal whether the email exists
  });

  app.post('/reset-password', async (c) => {
    const parsed = resetSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ code: 'validation_failed', message: 'Invalid input.' }, 400);
    const r = await createIdentityBundle(c.env).resetPassword.execute({
      token: parsed.data.token,
      newPasswordRaw: parsed.data.password,
    });
    return r.ok ? c.json({ ok: true }, 200) : respondError(c, r.error);
  });

  return app;
}
