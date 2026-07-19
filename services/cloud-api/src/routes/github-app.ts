import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { asAccountId, asSessionId } from '@cloudstudio/cloud-kernel';
import type { Env } from '../env.js';
import { createIdentityBundle } from '../composition.js';
import { opaqueTokens } from '../infra/opaque-tokens.js';
import { cryptoIdGen, systemClock } from '../infra/runtime.js';
import { requireClaims, unauthorized } from '../middleware/auth.js';
import { recordAudit } from '../middleware/audit.js';
import { githubAppConfig } from '../github-app/config.js';
import { signGitHubConnectState, verifyGitHubConnectState } from '../github-app/crypto.js';
import {
  createGitHubPullRequest,
  createInstallationToken,
  exchangeGitHubUserCode,
  githubUserAuthorizeUrl,
  GitHubApiError,
  listUserInstallations,
  repositoryInstallation,
} from '../github-app/github-api.js';
import { createGitHubAppRepo } from '../github-app/repo.js';

type Ctx = Context<{ Bindings: Env }>;

const repositorySchema = z.object({
  host: z.string().trim().min(1).max(253).default('github.com'),
  owner: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
  repo: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
});
const grantSchema = repositorySchema.extend({ operation: z.enum(['push', 'fetch']) });
const pullRequestSchema = repositorySchema.extend({
  head: z.string().trim().min(1).max(255),
  base: z.string().trim().min(1).max(255),
  title: z.string().trim().min(1).max(256),
  body: z.string().max(64 * 1024).optional().default(''),
  draft: z.boolean().optional().default(true),
});
const refUnsafe = /[\0-\x20~^:?*[\\]/;
const GRANT_TTL_MS = 90 * 1000;

function callbackUrl(env: Env): string {
  const base = env.OAUTH_PUBLIC_BASE_URL ?? env.APP_BASE_URL;
  return `${base.replace(/\/$/, '')}/v1/github/callback`;
}

function htmlResult(c: Ctx, ok: boolean, message: string) {
  const title = ok ? 'GitHub connected' : 'GitHub connection failed';
  return c.html(
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>${message}</p><p>You can close this window and return to MegaBrain.</p></body></html>`,
    ok ? 200 : 400,
  );
}

function unconfigured(c: Ctx) {
  return c.json({ code: 'github_app_unconfigured', message: 'The managed GitHub identity is not configured.' }, 503);
}

function validateRef(value: string): boolean {
  return !refUnsafe.test(value) && !value.includes('..') && !value.endsWith('.') && !value.endsWith('/');
}

async function authenticated(c: Ctx) {
  const bundle = createIdentityBundle(c.env);
  const claims = await requireClaims(c, bundle);
  return claims ? { bundle, claims, accountId: String(claims.sub) } : null;
}

export function githubAppRouter(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.get('/installations', async (c) => {
    const auth = await authenticated(c);
    if (!auth) return unauthorized(c);
    const config = githubAppConfig(c.env);
    const installations = await createGitHubAppRepo(c.env.DB).list(auth.accountId);
    return c.json({ configured: config != null, host: config?.host ?? 'github.com', appSlug: config?.slug ?? 'megabrainstudio', installations }, 200);
  });

  app.post('/connect', async (c) => {
    const auth = await authenticated(c);
    if (!auth) return unauthorized(c);
    const config = githubAppConfig(c.env);
    if (!config) return unconfigured(c);
    const state = await signGitHubConnectState(config.stateSecret, {
      accountId: auth.accountId,
      sessionId: String(auth.claims.sid),
      nonce: cryptoIdGen.uuid(),
      iat: systemClock.now(),
    });
    const url = `${config.webUrl}/apps/${encodeURIComponent(config.slug)}/installations/new?state=${encodeURIComponent(state)}`;
    recordAudit(c, 'github_app_connect_started', 200, { accountId: auth.accountId });
    return c.json({ url }, 200);
  });

  // Setup URL fallback for apps that do not have "Request user authorization
  // during installation" enabled. The installation_id is carried into a fresh,
  // signed state and is still verified against /user/installations in callback.
  app.get('/setup', async (c) => {
    const config = githubAppConfig(c.env);
    if (!config) return htmlResult(c, false, 'The integration is not configured.');
    const stateToken = c.req.query('state') ?? '';
    const installationId = Number(c.req.query('installation_id'));
    const state = await verifyGitHubConnectState(config.stateSecret, stateToken, systemClock.now());
    if (!state || !Number.isSafeInteger(installationId) || installationId <= 0) return htmlResult(c, false, 'This connection link is invalid or expired.');
    const nextState = await signGitHubConnectState(config.stateSecret, { ...state, installationId });
    return c.redirect(githubUserAuthorizeUrl(config, nextState, callbackUrl(c.env)), 302);
  });

  app.get('/callback', async (c) => {
    const config = githubAppConfig(c.env);
    if (!config) return htmlResult(c, false, 'The integration is not configured.');
    const code = c.req.query('code') ?? '';
    const stateToken = c.req.query('state') ?? '';
    const queryInstallationId = Number(c.req.query('installation_id'));
    const state = await verifyGitHubConnectState(config.stateSecret, stateToken, systemClock.now());
    if (!state || !code) return htmlResult(c, false, 'This connection link is invalid or expired.');
    const session = await createIdentityBundle(c.env).sessions.findActive(asSessionId(state.sessionId));
    if (!session || String(session.accountId) !== state.accountId) return htmlResult(c, false, 'Your MegaBrain session expired. Sign in and connect again.');

    try {
      const userToken = await exchangeGitHubUserCode(config, code, callbackUrl(c.env));
      const accessible = (await listUserInstallations(config, userToken)).filter((installation) => installation.app_id === config.appId);
      const expectedId = state.installationId ?? (Number.isSafeInteger(queryInstallationId) && queryInstallationId > 0 ? queryInstallationId : undefined);
      const selected = expectedId ? accessible.filter((installation) => installation.id === expectedId) : accessible;
      if (selected.length === 0) {
        recordAudit(c, 'github_app_connect_rejected', 403, { accountId: state.accountId, reason: 'installation_not_accessible' });
        return htmlResult(c, false, 'GitHub did not confirm that this installation belongs to the authorized user.');
      }
      await createGitHubAppRepo(c.env.DB).linkInstallations(state.accountId, selected);
      recordAudit(c, 'github_app_connected', 200, { accountId: state.accountId, installationCount: selected.length });
      return htmlResult(c, true, `${selected.length} GitHub installation${selected.length === 1 ? '' : 's'} connected.`);
    } catch (error) {
      console.error('[github-app] callback failed', { status: error instanceof GitHubApiError ? error.status : 500, error: String(error) });
      recordAudit(c, 'github_app_connect_failed', 502, { accountId: state.accountId });
      return htmlResult(c, false, 'GitHub could not complete the connection.');
    }
  });

  app.get('/repository', async (c) => {
    const auth = await authenticated(c);
    if (!auth) return unauthorized(c);
    const parsed = repositorySchema.safeParse({ host: c.req.query('host') ?? 'github.com', owner: c.req.query('owner'), repo: c.req.query('repo') });
    if (!parsed.success) return c.json({ code: 'invalid_repository', message: 'Repository is invalid.' }, 400);
    const config = githubAppConfig(c.env);
    if (!config) return c.json({ available: false, configured: false, reason: 'not_configured' }, 200);
    if (parsed.data.host.toLowerCase() !== config.host) {
      return c.json({ available: false, configured: true, reason: 'unsupported_host', host: parsed.data.host }, 200);
    }
    try {
      const installation = await repositoryInstallation(config, parsed.data.owner, parsed.data.repo);
      const linked = await createGitHubAppRepo(c.env.DB).find(auth.accountId, installation.id);
      if (!linked) return c.json({ available: false, configured: true, reason: 'not_connected', installationId: installation.id }, 200);
      if (installation.suspended_at || linked.suspendedAt) return c.json({ available: false, configured: true, reason: 'suspended', installation: linked }, 200);
      return c.json({ available: true, configured: true, installation: linked }, 200);
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return c.json({ available: false, configured: true, reason: 'not_installed' }, 200);
      console.error('[github-app] repository probe failed', { status: error instanceof GitHubApiError ? error.status : 500 });
      return c.json({ available: false, configured: true, reason: 'authentication_failed' }, 200);
    }
  });

  app.delete('/installations/:installationId', async (c) => {
    const auth = await authenticated(c);
    if (!auth) return unauthorized(c);
    const installationId = Number(c.req.param('installationId'));
    if (!Number.isSafeInteger(installationId) || installationId <= 0) return c.json({ code: 'invalid_installation', message: 'Installation is invalid.' }, 400);
    const removed = await createGitHubAppRepo(c.env.DB).unlink(auth.accountId, installationId);
    recordAudit(c, 'github_app_disconnected', removed ? 200 : 404, { accountId: auth.accountId, installationId });
    return removed ? c.json({ disconnected: true }, 200) : c.json({ code: 'not_found', message: 'Installation not found.' }, 404);
  });

  app.post('/grants', async (c) => {
    const auth = await authenticated(c);
    if (!auth) return unauthorized(c);
    const parsed = grantSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ code: 'invalid_grant', message: 'Managed Git request is invalid.' }, 400);
    const config = githubAppConfig(c.env);
    if (!config) return unconfigured(c);
    if (parsed.data.host.toLowerCase() !== config.host) return c.json({ code: 'unsupported_host', message: 'This GitHub App is not configured for that host.' }, 409);
    try {
      const installation = await repositoryInstallation(config, parsed.data.owner, parsed.data.repo);
      const linked = await createGitHubAppRepo(c.env.DB).find(auth.accountId, installation.id);
      if (!linked || linked.suspendedAt || installation.suspended_at) return c.json({ code: 'github_installation_unavailable', message: 'Connect an active GitHub App installation for this repository.' }, 409);
      const issued = await opaqueTokens.issue();
      const expiresAt = systemClock.now() + GRANT_TTL_MS;
      await createGitHubAppRepo(c.env.DB).createGrant({
        tokenHash: issued.hash,
        expiresAt,
        accountId: auth.accountId,
        installationId: installation.id,
        repositoryOwner: parsed.data.owner,
        repositoryName: parsed.data.repo,
        operation: parsed.data.operation,
      });
      recordAudit(c, 'github_app_grant_issued', 200, { accountId: auth.accountId, installationId: installation.id, operation: parsed.data.operation });
      return c.json({ grant: issued.token, expiresAt }, 200);
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return c.json({ code: 'github_app_not_installed', message: 'Install MegaBrainStudio for this repository.' }, 409);
      console.error('[github-app] grant issue failed', { status: error instanceof GitHubApiError ? error.status : 500 });
      return c.json({ code: 'github_unavailable', message: 'GitHub is temporarily unavailable.' }, 502);
    }
  });

  // This exchange is intentionally authenticated by the high-entropy, scoped,
  // one-use grant itself. It is called by the isolated local broker child, not by
  // the renderer. The real installation token is never stored in D1.
  app.post('/grants/exchange', async (c) => {
    const config = githubAppConfig(c.env);
    if (!config) return unconfigured(c);
    const body = (await c.req.json().catch(() => ({}))) as { grant?: unknown };
    const grant = typeof body.grant === 'string' ? body.grant : '';
    if (grant.length < 32 || grant.length > 256) return c.json({ code: 'grant_invalid', message: 'Grant is invalid or expired.' }, 401);
    const claimed = await createGitHubAppRepo(c.env.DB).claimGrant(await opaqueTokens.hashOf(grant), systemClock.isoNow());
    if (!claimed) return c.json({ code: 'grant_invalid', message: 'Grant is invalid or expired.' }, 401);
    try {
      const permissions = claimed.operation === 'push' ? { contents: 'write' as const } : { contents: 'read' as const };
      const token = await createInstallationToken(config, claimed.installationId, claimed.repositoryName, permissions);
      c.executionCtx.waitUntil(createGitHubAppRepo(c.env.DB).recordUsage({
        id: cryptoIdGen.uuid(), accountId: claimed.accountId, installationId: claimed.installationId, operation: claimed.operation, outcome: 'token_issued',
      }).catch((error) => console.error('[github-app] usage write failed', String(error))));
      return c.json({
        token: token.token,
        expiresAt: token.expiresAt,
        username: 'x-access-token',
        repositoryUrl: `${config.webUrl}/${encodeURIComponent(claimed.repositoryOwner)}/${encodeURIComponent(claimed.repositoryName)}.git`,
      }, 200);
    } catch (error) {
      console.error('[github-app] grant exchange failed', { status: error instanceof GitHubApiError ? error.status : 500 });
      return c.json({ code: 'github_token_failed', message: 'GitHub could not authorize this operation.' }, 502);
    }
  });

  app.post('/pull-requests', async (c) => {
    const auth = await authenticated(c);
    if (!auth) return unauthorized(c);
    const parsed = pullRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success || !validateRef(parsed.data?.head ?? '') || !validateRef(parsed.data?.base ?? '')) {
      return c.json({ code: 'invalid_pull_request', message: 'Pull request input is invalid.' }, 400);
    }
    const config = githubAppConfig(c.env);
    if (!config) return unconfigured(c);
    if (parsed.data.host.toLowerCase() !== config.host) return c.json({ code: 'unsupported_host', message: 'This GitHub App is not configured for that host.' }, 409);
    try {
      const installation = await repositoryInstallation(config, parsed.data.owner, parsed.data.repo);
      const linked = await createGitHubAppRepo(c.env.DB).find(auth.accountId, installation.id);
      if (!linked || linked.suspendedAt || installation.suspended_at) return c.json({ code: 'github_installation_unavailable', message: 'Connect an active GitHub App installation for this repository.' }, 409);
      const pull = await createGitHubPullRequest(config, installation.id, parsed.data);
      c.executionCtx.waitUntil(createGitHubAppRepo(c.env.DB).recordUsage({
        id: cryptoIdGen.uuid(), accountId: auth.accountId, installationId: installation.id, operation: 'pull_request', outcome: 'created',
      }).catch((error) => console.error('[github-app] usage write failed', String(error))));
      recordAudit(c, 'github_app_pull_request_created', 201, { accountId: auth.accountId, installationId: installation.id, pullRequestNumber: pull.number });
      return c.json({ number: pull.number, url: pull.html_url, title: pull.title, state: pull.state, appSlug: linked.appSlug, installationId: installation.id }, 201);
    } catch (error) {
      console.error('[github-app] pull request failed', { status: error instanceof GitHubApiError ? error.status : 500 });
      return c.json({ code: 'github_pull_request_failed', message: 'GitHub could not create the pull request.' }, 502);
    }
  });

  return app;
}
