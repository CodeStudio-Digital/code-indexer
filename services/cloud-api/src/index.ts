/**
 * CodeStudio Cloud API — Worker entry. Hono app; routers are mounted per
 * bounded context. The per-request composition root (composition.ts) wires env
 * bindings → adapters → use-cases inside each router. JSON-only API.
 */
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Env } from './env.js';
import { authRouter } from './routes/auth.js';
import { sessionsRouter } from './routes/sessions.js';
import { twoFactorRouter } from './routes/two-factor.js';
import { emailRouter } from './routes/email.js';
import { billingRouter } from './routes/billing.js';
import { sharingRouter, publicShareRouter } from './routes/sharing.js';

const app = new Hono<{ Bindings: Env }>();

// Body caps are scoped: auth/billing payloads are tiny (anti-amplification),
// while a share snapshot is a whole conversation (capped at ~2 MB; the use-case
// re-checks the canonical size). GET routes carry no body, so they're unaffected.
const tooLarge = (c: Context<{ Bindings: Env }>) => c.json({ code: 'payload_too_large', message: 'Request too large.' }, 413);
app.use('/v1/auth/*', bodyLimit({ maxSize: 32 * 1024, onError: tooLarge }));
app.use('/v1/billing/*', bodyLimit({ maxSize: 64 * 1024, onError: tooLarge }));
app.use('/v1/share', bodyLimit({ maxSize: 2 * 1024 * 1024, onError: tooLarge }));
app.use('/v1/share/*', bodyLimit({ maxSize: 2 * 1024 * 1024, onError: tooLarge }));

app.get('/v1/health', (c) =>
  c.json({
    ok: true,
    service: 'codestudio-cloud-api',
    env: c.env.ENVIRONMENT,
    ts: new Date().toISOString(),
  }),
);

app.route('/v1/auth', authRouter());
app.route('/v1/auth', sessionsRouter());
app.route('/v1/auth', twoFactorRouter());
app.route('/v1/auth', emailRouter());
app.route('/v1/billing', billingRouter());
app.route('/v1/share', sharingRouter());
app.route('/s', publicShareRouter()); // public read-only viewer (no auth)

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
