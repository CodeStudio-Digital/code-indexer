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
import { enforceRateLimit, MINUTE, HOUR } from '../middleware/rate-limit.js';
import { recordAudit } from '../middleware/audit.js';
import { hashPii } from '../infra/sha256.js';
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
    const limited = await enforceRateLimit(c, [{ key: `resend:acct:${claims.sub}`, limit: 3, windowMs: 15 * MINUTE }]);
    if (limited) return limited;
    const account = await bundle.accounts.findById(asAccountId(claims.sub));
    if (!account) return unauthorized(c);
    if (account.isEmailVerified) return c.json({ ok: true, alreadyVerified: true }, 200);
    await bundle.sendVerification.execute({ accountId: asAccountId(claims.sub), email: account.email });
    return c.json({ ok: true }, 200);
  });

  app.post('/request-password-reset', async (c) => {
    const parsed = requestResetSchema.safeParse(await c.req.json().catch(() => ({})));
    if (parsed.success) {
      // Rate-limit per IP AND per email (email-bomb / cost guard) — but still
      // always return 200 so the limit never becomes an enumeration oracle.
      const ip = c.req.header('cf-connecting-ip') ?? null;
      const pepper = c.env.IP_HASH_SALT ?? '';
      const ipHash = ip ? await hashPii(ip, pepper) : 'noip';
      const emailHash = await hashPii(parsed.data.email.toLowerCase(), pepper);
      const limited = await enforceRateLimit(c, [
        { key: `pwreset:ip:${ipHash}`, limit: 10, windowMs: HOUR },
        { key: `pwreset:email:${emailHash}`, limit: 3, windowMs: HOUR },
      ]);
      if (!limited) {
        await createIdentityBundle(c.env).requestPasswordReset.execute({ emailRaw: parsed.data.email });
      }
    }
    return c.json({ ok: true }, 200); // never reveal whether the email exists (or was throttled)
  });

  app.post('/reset-password', async (c) => {
    const parsed = resetSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ code: 'validation_failed', message: 'Invalid input.' }, 400);
    const r = await createIdentityBundle(c.env).resetPassword.execute({
      token: parsed.data.token,
      newPasswordRaw: parsed.data.password,
    });
    if (r.ok) {
      recordAudit(c, 'password_reset', 200, { accountId: r.value.accountId });
      return c.json({ ok: true }, 200);
    }
    return respondError(c, r.error);
  });

  return app;
}
