/**
 * Identity HTTP routes (Hono). Thin: validate with zod → call the use-case →
 * map Result to JSON + status via `identityHttpStatus`. The desktop client
 * stores the returned `refreshToken` in OS-secure storage (plan §7); we return
 * tokens in the JSON body (no cookies — this API is consumed by the app, not a
 * browser origin).
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { asAccountId } from '@cloudstudio/cloud-kernel';
import type { Env } from '../env.js';
import { createIdentityBundle } from '../composition.js';
import { sha256Hex } from '../infra/sha256.js';
import { requireClaims, unauthorized } from '../middleware/auth.js';
import { respondError } from './_respond.js';

type Ctx = Context<{ Bindings: Env }>;

const credsSchema = z.object({
  email: z.string().min(3).max(320),
  password: z.string().min(1).max(512),
});
const signupSchema = credsSchema.extend({ passwordConfirm: z.string().min(1).max(512).optional() });
const refreshSchema = z.object({ refreshToken: z.string().min(1).max(4096) });

const invalidInput = (c: Ctx, details: unknown) =>
  c.json({ code: 'validation_failed', message: 'Invalid input.', details }, 400);

async function reqCtx(c: Ctx): Promise<{ ua: string | null; ipHash: string | null }> {
  const ip = c.req.header('cf-connecting-ip') ?? null;
  return { ua: c.req.header('user-agent') ?? null, ipHash: ip ? await sha256Hex(ip) : null };
}

export function authRouter(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.post('/signup', async (c) => {
    const parsed = signupSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return invalidInput(c, parsed.error.flatten());
    if (parsed.data.passwordConfirm != null && parsed.data.passwordConfirm !== parsed.data.password) {
      return c.json({ code: 'password_mismatch', message: 'Passwords do not match.' }, 400);
    }
    const { ua, ipHash } = await reqCtx(c);
    const bundle = createIdentityBundle(c.env);
    const r = await bundle.signup.execute({
      emailRaw: parsed.data.email,
      passwordRaw: parsed.data.password,
      userAgent: ua,
      ipHash,
    });
    if (!r.ok) return respondError(c, r.error);
    // Best-effort verification email (never fail signup if delivery hiccups).
    try {
      await bundle.sendVerification.execute({ accountId: asAccountId(r.value.account.id), email: r.value.account.email });
    } catch {
      /* ignore */
    }
    return c.json(r.value, 201);
  });

  app.post('/login', async (c) => {
    const parsed = credsSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return invalidInput(c, parsed.error.flatten());
    const { ua, ipHash } = await reqCtx(c);
    const r = await createIdentityBundle(c.env).login.execute({
      emailRaw: parsed.data.email,
      passwordRaw: parsed.data.password,
      userAgent: ua,
      ipHash,
    });
    return r.ok ? c.json(r.value, 200) : respondError(c, r.error);
  });

  app.post('/refresh', async (c) => {
    const parsed = refreshSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return invalidInput(c, parsed.error.flatten());
    const r = await createIdentityBundle(c.env).refresh.execute({ refreshToken: parsed.data.refreshToken });
    return r.ok ? c.json(r.value, 200) : respondError(c, r.error);
  });

  app.get('/me', async (c) => {
    const bundle = createIdentityBundle(c.env);
    const claims = await requireClaims(c, bundle);
    if (!claims) return unauthorized(c);
    const account = await bundle.accounts.findById(asAccountId(claims.sub));
    if (!account) return unauthorized(c);
    return c.json({ account: account.toPublic(), session: { id: claims.sid } }, 200);
  });

  return app;
}
