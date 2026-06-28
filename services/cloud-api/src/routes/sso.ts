/**
 * Per-org OIDC Single Sign-On (Enterprise). Mirrors the browser-OAuth flow
 * (routes/oauth.ts) but the IdP is the ORG's, discovered at runtime, and the org id
 * rides inside the signed `state` so the callback is org-agnostic (one redirect URI
 * to register: <OAUTH_PUBLIC_BASE_URL>/v1/auth/sso/callback).
 *
 *   POST /sso/:orgId/config  → org owner/admin sets the IdP (issuer/client/secret/
 *                              allowed_domains). Gated on the org's `sso` entitlement.
 *   GET  /sso/:orgId/config  → read it back (secret redacted).
 *   GET  /sso/:orgId/start   → 302 to the org IdP (PKCE + signed state w/ orgId).
 *   GET  /sso/callback       → exchange → DOMAIN-GATE + verified-email → resolve
 *                              account → JIT org membership → session → handoff.
 *
 * Security: an SSO login is accepted only when the IdP asserts the email is VERIFIED
 * AND its domain is on the org's allow-list (anti-takeover); account linking reuses
 * the same takeover-safe ResolveOAuthIdentityUseCase, namespaced per org so one org's
 * IdP can never resolve to a link minted by another.
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { asSessionId } from '@cloudstudio/cloud-kernel';
import type { Env } from '../env.js';
import { createIdentityBundle } from '../composition.js';
import { resolveOrgEntitlements } from '../entitlements.js';
import { createD1Executor } from '../infra/d1/d1-executor.js';
import { createTeamsRepo } from '../infra/d1/teams-repo.js';
import { createOrgSsoRepo } from '../infra/d1/org-sso-repo.js';
import { createOAuthHandoffRepo } from '../infra/d1/oauth-handoff-repo.js';
import { encryptSecret, decryptSecret } from '../infra/secret-cipher.js';
import { discoverOidc, oidcProvider, isEmailDomainAllowed } from '../infra/oauth/oidc.js';
import { signState, verifyState, newCodeVerifier, codeChallengeS256, type StatePayload } from '../infra/oauth/state.js';
import { opaqueTokens } from '../infra/opaque-tokens.js';
import { cryptoIdGen, systemClock } from '../infra/runtime.js';
import { hashPii } from '../infra/sha256.js';
import { requireClaims, unauthorized } from '../middleware/auth.js';
import { recordAudit } from '../middleware/audit.js';

type Ctx = Context<{ Bindings: Env }>;

const STATE_MAX_AGE_MS = 10 * 60 * 1000;
const HANDOFF_TTL_MS = 120 * 1000;
const LOOPBACK_PORT = 7878;

const configSchema = z.object({
  issuer: z.string().url().max(512),
  clientId: z.string().min(1).max(512),
  clientSecret: z.string().min(1).max(2048),
  allowedDomains: z.array(z.string().min(3).max(253)).min(1).max(50),
  enabled: z.boolean().optional(),
});

function ssoCallbackUri(env: Env): string {
  const base = (env.OAUTH_PUBLIC_BASE_URL ?? env.APP_BASE_URL).replace(/\/$/, '');
  return `${base}/v1/auth/sso/callback`;
}

function htmlError(c: Ctx, message: string) {
  return c.html(
    `<!doctype html><html><head><meta charset="utf-8"><title>Sign-in</title></head><body><h1>Sign-in could not be completed</h1><p>${message}</p><p>You can close this window and return to CodeStudio.</p></body></html>`,
    400,
  );
}

/** Resolve the caller's claims and require they own/admin the org AND the org is
 *  SSO-entitled (Enterprise). Returns the accountId, or a Response to short-circuit. */
async function requireOrgSsoAdmin(c: Ctx, orgId: string): Promise<{ accountId: string } | Response> {
  const identity = createIdentityBundle(c.env);
  const claims = await requireClaims(c, identity);
  if (!claims) return unauthorized(c);
  const membership = await createTeamsRepo(createD1Executor(c.env.DB)).getMembership(orgId, claims.sub);
  if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
    return c.json({ code: 'forbidden', message: 'Org admin required.' }, 403);
  }
  const ent = await resolveOrgEntitlements(c.env, orgId);
  if (!ent.features.sso) return c.json({ code: 'entitlement_required', message: 'SSO requires the Enterprise plan.' }, 402);
  return { accountId: claims.sub };
}

export function ssoRouter(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  // ── Config (org owner/admin) ──────────────────────────────────────────────
  app.post('/sso/:orgId/config', async (c) => {
    if (!c.env.SSO_CONFIG_KEY) return c.json({ code: 'sso_unconfigured', message: 'SSO is not available on this server.' }, 404);
    const orgId = c.req.param('orgId');
    const gate = await requireOrgSsoAdmin(c, orgId);
    if (gate instanceof Response) return gate;
    const parsed = configSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ code: 'validation_failed', message: 'Invalid SSO config.' }, 400);
    const clientSecretEnc = await encryptSecret(c.env.SSO_CONFIG_KEY, parsed.data.clientSecret);
    await createOrgSsoRepo(createD1Executor(c.env.DB)).upsert({
      orgId,
      issuer: parsed.data.issuer,
      clientId: parsed.data.clientId,
      clientSecretEnc,
      allowedDomains: parsed.data.allowedDomains.map((d) => d.trim().toLowerCase()),
      enabled: parsed.data.enabled ?? true,
      nowMs: systemClock.now(),
    });
    recordAudit(c, 'org_sso_config_set', 200, { orgId, accountId: gate.accountId });
    return c.json({ ok: true }, 200);
  });

  app.get('/sso/:orgId/config', async (c) => {
    if (!c.env.SSO_CONFIG_KEY) return c.json({ code: 'sso_unconfigured', message: 'SSO is not available on this server.' }, 404);
    const orgId = c.req.param('orgId');
    const gate = await requireOrgSsoAdmin(c, orgId);
    if (gate instanceof Response) return gate;
    const cfg = await createOrgSsoRepo(createD1Executor(c.env.DB)).get(orgId);
    if (!cfg) return c.json({ configured: false }, 200);
    // Never return the (encrypted) secret — only whether SSO is set up + its shape.
    return c.json({ configured: true, issuer: cfg.issuer, clientId: cfg.clientId, allowedDomains: cfg.allowedDomains, enabled: cfg.enabled }, 200);
  });

  // ── Login flow ────────────────────────────────────────────────────────────
  app.get('/sso/:orgId/start', async (c) => {
    const secret = c.env.OAUTH_STATE_SECRET;
    if (!secret || !c.env.SSO_CONFIG_KEY) return c.json({ code: 'sso_unconfigured', message: 'SSO is not configured.' }, 404);
    const orgId = c.req.param('orgId');
    const ent = await resolveOrgEntitlements(c.env, orgId);
    if (!ent.features.sso) return c.json({ code: 'sso_unconfigured', message: 'SSO is not enabled for this organization.' }, 404);
    const cfg = await createOrgSsoRepo(createD1Executor(c.env.DB)).get(orgId);
    if (!cfg || !cfg.enabled) return c.json({ code: 'sso_unconfigured', message: 'SSO is not configured for this organization.' }, 404);
    const ep = await discoverOidc(cfg.issuer);
    if (!ep) return c.json({ code: 'sso_discovery_failed', message: 'Could not reach the identity provider.' }, 502);

    const clientSecret = await decryptSecret(c.env.SSO_CONFIG_KEY, cfg.clientSecretEnc);
    const provider = oidcProvider(`sso:${orgId}`, cfg.clientId, clientSecret, ep);

    const flow: StatePayload['flow'] = c.req.query('flow') === 'portal' ? 'portal' : 'desktop';
    const port = flow === 'desktop' ? LOOPBACK_PORT : undefined;
    const cv = newCodeVerifier();
    const challenge = await codeChallengeS256(cv);
    const state = await signState(secret, { flow, provider: 'sso', orgId, nonce: cryptoIdGen.uuid(), port, cv, iat: systemClock.now() });
    return c.redirect(provider.authorizeUrl({ state, redirectUri: ssoCallbackUri(c.env), codeChallenge: challenge }), 302);
  });

  app.get('/sso/callback', async (c) => {
    const secret = c.env.OAUTH_STATE_SECRET;
    if (!secret || !c.env.SSO_CONFIG_KEY) return htmlError(c, 'SSO is not configured.');
    const code = c.req.query('code');
    const stateTok = c.req.query('state');
    if (!code || !stateTok) return htmlError(c, 'Missing authorization response.');
    const state = await verifyState(secret, stateTok, STATE_MAX_AGE_MS, systemClock.now());
    if (!state || state.provider !== 'sso' || !state.orgId) return htmlError(c, 'This sign-in link expired or is invalid. Please try again.');
    const orgId = state.orgId;

    const ent = await resolveOrgEntitlements(c.env, orgId);
    if (!ent.features.sso) return htmlError(c, 'SSO is not enabled for this organization.');
    const cfg = await createOrgSsoRepo(createD1Executor(c.env.DB)).get(orgId);
    if (!cfg || !cfg.enabled) return htmlError(c, 'SSO is not configured for this organization.');
    const ep = await discoverOidc(cfg.issuer);
    if (!ep) return htmlError(c, 'Could not reach the identity provider.');

    let profile;
    try {
      const clientSecret = await decryptSecret(c.env.SSO_CONFIG_KEY, cfg.clientSecretEnc);
      profile = await oidcProvider(`sso:${orgId}`, cfg.clientId, clientSecret, ep).exchangeCode({
        code,
        redirectUri: ssoCallbackUri(c.env),
        codeVerifier: state.cv,
      });
    } catch (e) {
      console.error('[sso] code exchange failed', e);
      return htmlError(c, 'Could not complete sign-in with your identity provider.');
    }

    // Anti-takeover: the IdP must assert a VERIFIED email whose domain is on the
    // org's allow-list. Without both, refuse (a hostile/misconfigured IdP must not
    // be able to mint or seize accounts outside the org's domains).
    if (!profile.emailVerified || !isEmailDomainAllowed(profile.email, cfg.allowedDomains)) {
      recordAudit(c, 'sso_login_domain_reject', 403, { orgId, provider: `sso:${orgId}` });
      return htmlError(c, 'Your identity provider account is not allowed to sign in to this organization.');
    }

    const bundle = createIdentityBundle(c.env);
    const resolved = await bundle.resolveOAuth.execute({
      provider: `sso:${orgId}`,
      providerUserId: profile.providerUserId,
      email: profile.email,
      emailVerified: profile.emailVerified,
      name: profile.name,
    });
    if (!resolved.ok) {
      recordAudit(c, 'sso_login_fail', 400, { orgId, reason: resolved.error.code });
      return htmlError(c, resolved.error.message);
    }
    const account = resolved.value.account;

    // SSO must not bypass an enabled second factor.
    const tf = await bundle.twoFactor.getSecret(account.id);
    if (tf?.enabled) {
      recordAudit(c, 'sso_login_2fa_block', 403, { orgId, accountId: account.id });
      return htmlError(c, 'This account uses two-factor authentication. Sign in with your email and password on the web portal.');
    }

    // JIT provisioning: ensure the user is a member of the org (idempotent). SSO is
    // Enterprise-only (unlimited seats), so no seat-exhaustion gate is needed here.
    await createTeamsRepo(createD1Executor(c.env.DB)).addMember({ orgId, accountId: account.id, role: 'member', createdAtMs: systemClock.now() });

    const ip = c.req.header('cf-connecting-ip') ?? null;
    const session = await bundle.issuer.issue({
      accountId: account.id,
      emailVerified: account.isEmailVerified,
      userAgent: c.req.header('user-agent') ?? null,
      ipHash: ip ? await hashPii(ip, c.env.IP_HASH_SALT ?? '') : null,
    });

    const handoff = (await opaqueTokens.issue()).token;
    await createOAuthHandoffRepo(createD1Executor(c.env.DB)).create(
      handoff,
      JSON.stringify({ account: account.toPublic(), session }),
      systemClock.now() + HANDOFF_TTL_MS,
    );
    recordAudit(c, 'sso_login_ok', 200, { orgId, accountId: account.id, outcome: resolved.value.outcome });

    if (state.flow === 'portal') {
      const base = (c.env.PORTAL_BASE_URL ?? c.env.APP_BASE_URL).replace(/\/$/, '');
      return c.redirect(`${base}/auth/done#handoff=${encodeURIComponent(handoff)}`, 302);
    }
    return c.redirect(`http://127.0.0.1:${state.port ?? LOOPBACK_PORT}/cb?handoff=${encodeURIComponent(handoff)}`, 302);
  });

  return app;
}
