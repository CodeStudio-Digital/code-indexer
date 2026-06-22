/**
 * Browser OAuth routes (P7-B). Worker-mediated: the worker holds provider secrets;
 * the desktop/portal only ever see a one-time handoff code.
 *   GET  /oauth/:provider/start    → 302 to the provider (PKCE + signed state)
 *   GET  /oauth/:provider/callback → exchange code → resolve account → issue session
 *                                    → mint handoff → 302 to loopback or portal
 *   POST /oauth/redeem             → consume handoff (one-shot) → {account, session}
 * Mounted at /v1/auth, so paths are /v1/auth/oauth/*. `redeem` is wired as a
 * `session:'establish'` op so the desktop's existing token interception reuses it.
 */
import { Hono, type Context } from 'hono';
import { asSessionId } from '@cloudstudio/cloud-kernel';
import type { Env } from '../env.js';
import { createIdentityBundle } from '../composition.js';
import { createD1Executor } from '../infra/d1/d1-executor.js';
import { createOAuthHandoffRepo } from '../infra/d1/oauth-handoff-repo.js';
import { providerFor } from '../infra/oauth/registry.js';
import { signState, verifyState, newCodeVerifier, codeChallengeS256, type StatePayload } from '../infra/oauth/state.js';
import { opaqueTokens } from '../infra/opaque-tokens.js';
import { cryptoIdGen, systemClock } from '../infra/runtime.js';
import { hashPii } from '../infra/sha256.js';
import { recordAudit } from '../middleware/audit.js';

type Ctx = Context<{ Bindings: Env }>;

const STATE_MAX_AGE_MS = 10 * 60 * 1000;
const HANDOFF_TTL_MS = 120 * 1000;
const LOOPBACK_PORT = 7878;

function callbackUri(env: Env, provider: string): string {
  const base = env.OAUTH_PUBLIC_BASE_URL ?? env.APP_BASE_URL;
  return `${base.replace(/\/$/, '')}/v1/auth/oauth/${provider}/callback`;
}

/** Minimal, style-free HTML so the strict default-src 'none' CSP renders it. */
function htmlError(c: Ctx, message: string) {
  return c.html(
    `<!doctype html><html><head><meta charset="utf-8"><title>Sign-in</title></head><body><h1>Sign-in could not be completed</h1><p>${message}</p><p>You can close this window and return to CodeStudio.</p></body></html>`,
    400,
  );
}

export function oauthRouter(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.get('/oauth/:provider/start', async (c) => {
    const secret = c.env.OAUTH_STATE_SECRET;
    if (!secret) return c.json({ code: 'oauth_unconfigured', message: 'OAuth is not configured.' }, 404);
    const id = c.req.param('provider');
    const provider = providerFor(c.env, id);
    if (!provider) return c.json({ code: 'oauth_unconfigured', message: 'Unknown or unconfigured provider.' }, 404);

    const flow: StatePayload['flow'] = c.req.query('flow') === 'portal' ? 'portal' : 'desktop';
    // Only the fixed loopback port is honored (never reflect an arbitrary port).
    const port = flow === 'desktop' ? LOOPBACK_PORT : undefined;
    const cv = newCodeVerifier();
    const challenge = await codeChallengeS256(cv);
    const state = await signState(secret, { flow, provider: id, nonce: cryptoIdGen.uuid(), port, cv, iat: systemClock.now() });
    return c.redirect(provider.authorizeUrl({ state, redirectUri: callbackUri(c.env, id), codeChallenge: challenge }), 302);
  });

  app.get('/oauth/:provider/callback', async (c) => {
    const secret = c.env.OAUTH_STATE_SECRET;
    if (!secret) return htmlError(c, 'OAuth is not configured.');
    const id = c.req.param('provider');
    const provider = providerFor(c.env, id);
    if (!provider) return htmlError(c, 'Unknown provider.');

    const code = c.req.query('code');
    const stateTok = c.req.query('state');
    if (!code || !stateTok) return htmlError(c, 'Missing authorization response.');
    const state = await verifyState(secret, stateTok, STATE_MAX_AGE_MS, systemClock.now());
    if (!state || state.provider !== id) return htmlError(c, 'This sign-in link expired or is invalid. Please try again.');

    let profile;
    try {
      profile = await provider.exchangeCode({ code, redirectUri: callbackUri(c.env, id), codeVerifier: state.cv });
    } catch (e) {
      console.error('[oauth] code exchange failed', e);
      return htmlError(c, 'Could not complete sign-in with the provider.');
    }

    const bundle = createIdentityBundle(c.env);
    const resolved = await bundle.resolveOAuth.execute({
      provider: id,
      providerUserId: profile.providerUserId,
      email: profile.email,
      emailVerified: profile.emailVerified,
      name: profile.name,
    });
    if (!resolved.ok) {
      recordAudit(c, 'oauth_login_fail', 400, { provider: id, reason: resolved.error.code });
      return htmlError(c, resolved.error.message);
    }
    const account = resolved.value.account;

    // OAuth must not bypass an enabled second factor (don't downgrade the user's
    // hardening). v1: send 2FA accounts to email+password on the portal.
    const tf = await bundle.twoFactor.getSecret(account.id);
    if (tf?.enabled) {
      recordAudit(c, 'oauth_login_2fa_block', 403, { provider: id, accountId: account.id });
      return htmlError(c, 'This account uses two-factor authentication. Sign in with your email and password on the web portal.');
    }

    const ip = c.req.header('cf-connecting-ip') ?? null;
    const session = await bundle.issuer.issue({
      accountId: account.id,
      emailVerified: account.isEmailVerified,
      userAgent: c.req.header('user-agent') ?? null,
      ipHash: ip ? await hashPii(ip, c.env.IP_HASH_SALT ?? '') : null,
    });

    const handoff = (await opaqueTokens.issue()).token;
    const repo = createOAuthHandoffRepo(createD1Executor(c.env.DB));
    await repo.create(handoff, JSON.stringify({ account: account.toPublic(), session }), systemClock.now() + HANDOFF_TTL_MS);
    recordAudit(c, 'oauth_login_ok', 200, { provider: id, accountId: account.id, outcome: resolved.value.outcome });

    if (state.flow === 'portal') {
      const base = (c.env.PORTAL_BASE_URL ?? c.env.APP_BASE_URL).replace(/\/$/, '');
      return c.redirect(`${base}/auth/done#handoff=${encodeURIComponent(handoff)}`, 302);
    }
    return c.redirect(`http://127.0.0.1:${state.port ?? LOOPBACK_PORT}/cb?handoff=${encodeURIComponent(handoff)}`, 302);
  });

  app.post('/oauth/redeem', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { handoff?: unknown };
    const handoff = typeof body.handoff === 'string' ? body.handoff : '';
    if (!handoff) return c.json({ code: 'handoff_invalid', message: 'Missing handoff.' }, 400);
    const repo = createOAuthHandoffRepo(createD1Executor(c.env.DB));
    const payload = await repo.claim(handoff, systemClock.isoNow());
    if (!payload) return c.json({ code: 'handoff_invalid', message: 'This sign-in could not be completed. Please try again.' }, 400);
    const result = JSON.parse(payload) as { account: unknown; session: { sessionId: string } };

    // Attach the REDEEMING device's identity (the callback ran in the browser; the
    // desktop sends its real headers here). Best-effort, never blocks the response.
    const cf = (c.req.raw as unknown as { cf?: { country?: string; city?: string } }).cf;
    c.executionCtx.waitUntil(
      createIdentityBundle(c.env)
        .sessions.setDeviceInfo(asSessionId(result.session.sessionId), {
          deviceName: c.req.header('x-cs-device-name') ?? null,
          osRelease: c.req.header('x-cs-os-release') ?? null,
          geoCountry: cf?.country ?? null,
          geoCity: cf?.city ?? null,
        })
        .catch(() => {}),
    );
    return c.json(result, 200);
  });

  return app;
}
