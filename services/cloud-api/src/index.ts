/**
 * CodeStudio Cloud API — Worker entry. Hono app; routers are mounted per
 * bounded context. The per-request composition root (composition.ts) wires env
 * bindings → adapters → use-cases inside each router. JSON-only API.
 */
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Env } from './env.js';
import { authRouter } from './routes/auth.js';
import { oauthRouter } from './routes/oauth.js';
import { ssoRouter } from './routes/sso.js';
import { sessionsRouter } from './routes/sessions.js';
import { twoFactorRouter } from './routes/two-factor.js';
import { emailRouter } from './routes/email.js';
import { billingRouter } from './routes/billing.js';
import { sharingRouter, publicShareRouter } from './routes/sharing.js';
import { docsRouter, publicDocsRouter } from './routes/docs.js';
import { syncRouter } from './routes/sync.js';
import { backupsRouter } from './routes/backups.js';
import { teamsRouter } from './routes/teams.js';
import { feedbackRouter } from './routes/feedback.js';
import { accountRouter } from './routes/account.js';
import { adminRouter } from './routes/admin.js';
import { githubAppRouter } from './routes/github-app.js';
import { securityHeaders, docsSecurityHeaders, corsAllowlist } from './middleware/security.js';

const app = new Hono<{ Bindings: Env }>();

// Edge security first: strict headers on every response + a CORS origin allowlist.
// The hosted-docs viewer (/d/*) is the one HTML surface, so it gets a relaxed,
// scoped CSP instead of the JSON API's `default-src 'none'`.
app.use('*', (c, next) => {
  const isDocsViewer = c.req.path === '/d' || c.req.path.startsWith('/d/');
  return (isDocsViewer ? docsSecurityHeaders() : securityHeaders())(c, next);
});
app.use('*', corsAllowlist());

// Body caps are scoped: auth/billing payloads are tiny (anti-amplification),
// while a share snapshot is a whole conversation (capped at ~2 MB; the use-case
// re-checks the canonical size). GET routes carry no body, so they're unaffected.
const tooLarge = (c: Context<{ Bindings: Env }>) => c.json({ code: 'payload_too_large', message: 'Request too large.' }, 413);
// Fail-closed config guard: a missing/weak access-token secret yields FORGEABLE
// tokens, and a missing PII pepper makes ip/email hashes reversible. Refuse to
// serve any real route (health stays up for liveness) if either is unsafe.
app.use('*', async (c, next) => {
  if (c.req.path === '/v1/health') return next();
  const secret = c.env.ACCESS_SIGNING_SECRET;
  if (!secret || secret.length < 32 || !c.env.IP_HASH_SALT) {
    console.error('[config] refusing to serve: ACCESS_SIGNING_SECRET missing/weak or IP_HASH_SALT unset');
    return c.json({ code: 'server_misconfigured', message: 'Service temporarily unavailable.' }, 503);
  }
  return next();
});

app.use('/v1/auth/*', bodyLimit({ maxSize: 32 * 1024, onError: tooLarge }));
app.use('/v1/billing/*', bodyLimit({ maxSize: 64 * 1024, onError: tooLarge }));
app.use('/v1/share', bodyLimit({ maxSize: 2 * 1024 * 1024, onError: tooLarge }));
app.use('/v1/share/*', bodyLimit({ maxSize: 2 * 1024 * 1024, onError: tooLarge }));
app.use('/v1/docs', bodyLimit({ maxSize: 2 * 1024 * 1024, onError: tooLarge })); // OpenAPI spec
app.use('/v1/docs/*', bodyLimit({ maxSize: 2 * 1024 * 1024, onError: tooLarge }));
app.use('/v1/sync/*', bodyLimit({ maxSize: 4 * 1024 * 1024, onError: tooLarge })); // a batch of synced docs
app.use('/v1/backups', bodyLimit({ maxSize: 25 * 1024 * 1024, onError: tooLarge })); // gz metadata bundle
app.use('/v1/backups/*', bodyLimit({ maxSize: 25 * 1024 * 1024, onError: tooLarge }));
app.use('/v1/orgs', bodyLimit({ maxSize: 32 * 1024, onError: tooLarge }));
app.use('/v1/orgs/*', bodyLimit({ maxSize: 32 * 1024, onError: tooLarge }));
app.use('/v1/feedback', bodyLimit({ maxSize: 32 * 1024, onError: tooLarge })); // submit JSON is small
app.use('/v1/feedback/*', bodyLimit({ maxSize: 6 * 1024 * 1024, onError: tooLarge })); // attachment ≤ 5 MB
app.use('/v1/account', bodyLimit({ maxSize: 32 * 1024, onError: tooLarge }));
app.use('/v1/account/*', bodyLimit({ maxSize: 32 * 1024, onError: tooLarge }));
app.use('/v1/admin/*', bodyLimit({ maxSize: 32 * 1024, onError: tooLarge }));
app.use('/v1/github/*', bodyLimit({ maxSize: 96 * 1024, onError: tooLarge }));

app.get('/v1/health', (c) =>
  c.json({
    ok: true,
    service: 'codestudio-cloud-api',
    env: c.env.ENVIRONMENT,
    ts: new Date().toISOString(),
  }),
);

app.route('/v1/auth', authRouter());
app.route('/v1/auth', oauthRouter());
app.route('/v1/auth', ssoRouter());
app.route('/v1/auth', sessionsRouter());
app.route('/v1/auth', twoFactorRouter());
app.route('/v1/auth', emailRouter());
app.route('/v1/billing', billingRouter());
app.route('/v1/share', sharingRouter());
app.route('/s', publicShareRouter()); // public read-only viewer (no auth)
app.route('/v1/docs', docsRouter());
app.route('/d', publicDocsRouter()); // public hosted-docs viewer (no auth)
app.route('/v1/sync', syncRouter());
app.route('/v1/backups', backupsRouter());
app.route('/v1/orgs', teamsRouter());
app.route('/v1/feedback', feedbackRouter());
app.route('/v1/account', accountRouter());
app.route('/v1/admin', adminRouter());
app.route('/v1/github', githubAppRouter());

// JSON-only API: never render HTML, even for 404s.
app.notFound((c) => c.json({ code: 'not_found', message: 'Not found' }, 404));

// Last-resort guard — log server-side, return a generic body (no internals).
app.onError((e, c) => {
  console.error('[cloud-api] unhandled error', e);
  return c.json({ code: 'internal', message: 'Something went wrong' }, 500);
});

export default app;

// Durable Object classes must be exported from the Worker entry.
export { LoginThrottleDO } from './login-throttle-do.js';
export { RateLimitDO } from './rate-limit-do.js';
