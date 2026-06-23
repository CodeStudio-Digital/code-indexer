/** Session management routes (all Bearer-protected): logout, logout-all, list. */
import { Hono } from 'hono';
import { asAccountId, asSessionId } from '@cloudstudio/cloud-kernel';
import type { Env } from '../env.js';
import { createIdentityBundle } from '../composition.js';
import { requireClaims, unauthorized } from '../middleware/auth.js';

export function sessionsRouter(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.post('/logout', async (c) => {
    const bundle = createIdentityBundle(c.env);
    const claims = await requireClaims(c, bundle);
    if (!claims) return unauthorized(c);
    await bundle.logout.execute({ accountId: asAccountId(claims.sub), sessionId: asSessionId(claims.sid) });
    return c.json({ ok: true }, 200);
  });

  app.post('/logout-all', async (c) => {
    const bundle = createIdentityBundle(c.env);
    const claims = await requireClaims(c, bundle);
    if (!claims) return unauthorized(c);
    await bundle.logoutAll.execute({ accountId: asAccountId(claims.sub) });
    return c.json({ ok: true }, 200);
  });

  app.get('/sessions', async (c) => {
    const bundle = createIdentityBundle(c.env);
    const claims = await requireClaims(c, bundle);
    if (!claims) return unauthorized(c);
    const r = await bundle.listSessions.execute({
      accountId: asAccountId(claims.sub),
      currentSessionId: asSessionId(claims.sid),
    });
    return c.json({ sessions: r.ok ? r.value : [] }, 200);
  });

  return app;
}
