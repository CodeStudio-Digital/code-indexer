/**
 * Identity HTTP routes (Hono). Thin: validate with zod → call the use-case →
 * map Result to JSON + status via `identityHttpStatus`. The desktop client
 * stores the returned `refreshToken` in OS-secure storage (plan §7); we return
 * tokens in the JSON body (no cookies — this API is consumed by the app, not a
 * browser origin).
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { asAccountId, asSessionId } from '@cloudstudio/cloud-kernel';
import { identityHttpStatus, type DeviceInfo } from '@cloudstudio/cloud-identity';
import type { Env } from '../env.js';
import { createIdentityBundle } from '../composition.js';
import { hashPii } from '../infra/sha256.js';
import { createBotVerifier } from '../infra/turnstile.js';
import { requireClaims, unauthorized } from '../middleware/auth.js';
import { enforceRateLimit, HOUR } from '../middleware/rate-limit.js';
import { recordAudit } from '../middleware/audit.js';
import { respondError } from './_respond.js';

type Ctx = Context<{ Bindings: Env }>;

const credsSchema = z.object({
  email: z.string().min(3).max(320),
  password: z.string().min(1).max(512),
});
const signupSchema = credsSchema.extend({
  passwordConfirm: z.string().min(1).max(512).optional(),
  turnstileToken: z.string().max(4096).optional(),
});
const loginSchema = credsSchema.extend({ turnstileToken: z.string().max(4096).optional() });
const refreshSchema = z.object({ refreshToken: z.string().min(1).max(4096) });

const invalidInput = (c: Ctx, details: unknown) =>
  c.json({ code: 'validation_failed', message: 'Invalid input.', details }, 400);

async function reqCtx(c: Ctx): Promise<{ ua: string | null; ipHash: string | null }> {
  const ip = c.req.header('cf-connecting-ip') ?? null;
  return { ua: c.req.header('user-agent') ?? null, ipHash: ip ? await hashPii(ip, c.env.IP_HASH_SALT ?? '') : null };
}

/** Real device identity from the desktop's headers + Cloudflare geo (coarse). The
 *  raw IP is never stored (only ip_hash). Display-only — set best-effort. */
function deviceInfo(c: Ctx): DeviceInfo {
  const cf = (c.req.raw as unknown as { cf?: { country?: string; city?: string } }).cf;
  return {
    deviceName: c.req.header('x-cs-device-name') ?? null,
    osRelease: c.req.header('x-cs-os-release') ?? null,
    geoCountry: cf?.country ?? null,
    geoCity: cf?.city ?? null,
  };
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
    // Signup fires a verification email → rate-limit per IP (email-bomb / cost guard).
    const limited = await enforceRateLimit(c, [{ key: `signup:ip:${ipHash}`, limit: 20, windowMs: HOUR }]);
    if (limited) return limited;
    // Bot check (active only once TURNSTILE_SECRET is set; no-op otherwise).
    const bot = createBotVerifier(c.env.TURNSTILE_SECRET);
    if (bot.enabled) {
      const ip = c.req.header('cf-connecting-ip') ?? null;
      if (!parsed.data.turnstileToken || !(await bot.verify(parsed.data.turnstileToken, ip))) {
        return c.json({ code: 'turnstile_failed', message: 'Bot verification failed.' }, 403);
      }
    }
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
    recordAudit(c, 'signup', 201, { accountId: r.value.account.id });
    c.executionCtx.waitUntil(bundle.sessions.setDeviceInfo(asSessionId(r.value.session.sessionId), deviceInfo(c)).catch(() => {}));
    return c.json(r.value, 201);
  });

  app.post('/login', async (c) => {
    const parsed = loginSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return invalidInput(c, parsed.error.flatten());
    const { ua, ipHash } = await reqCtx(c);
    // Bot check (active only once TURNSTILE_SECRET is set; no-op otherwise).
    const bot = createBotVerifier(c.env.TURNSTILE_SECRET);
    if (bot.enabled) {
      const ip = c.req.header('cf-connecting-ip') ?? null;
      if (!parsed.data.turnstileToken || !(await bot.verify(parsed.data.turnstileToken, ip))) {
        recordAudit(c, 'login_fail', 403, { reason: 'turnstile_failed' });
        return c.json({ code: 'turnstile_failed', message: 'Bot verification failed.' }, 403);
      }
    }
    const bundle = createIdentityBundle(c.env);
    const r = await bundle.login.execute({
      emailRaw: parsed.data.email,
      passwordRaw: parsed.data.password,
      userAgent: ua,
      ipHash,
    });
    if (r.ok) {
      recordAudit(c, 'login_ok', 200, { accountId: r.value.account.id });
      c.executionCtx.waitUntil(bundle.sessions.setDeviceInfo(asSessionId(r.value.session.sessionId), deviceInfo(c)).catch(() => {}));
      return c.json(r.value, 200);
    }
    recordAudit(c, 'login_fail', identityHttpStatus(r.error), { reason: r.error.code });
    return respondError(c, r.error);
  });

  app.post('/refresh', async (c) => {
    const parsed = refreshSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return invalidInput(c, parsed.error.flatten());
    const r = await createIdentityBundle(c.env).refresh.execute({ refreshToken: parsed.data.refreshToken });
    // Audit rotation — `token_reuse` here is the stolen-token / theft signal.
    if (r.ok) recordAudit(c, 'token_refresh', 200);
    else recordAudit(c, 'token_refresh_fail', identityHttpStatus(r.error), { reason: r.error.code });
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
