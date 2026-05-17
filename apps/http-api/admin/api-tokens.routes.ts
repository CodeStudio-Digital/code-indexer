import { Hono } from 'hono';
import type { AuthBundle } from '../auth/composition.js';

interface CreateTokenBody {
  name?: unknown;
  scopes?: unknown;
  expiresInDays?: unknown;
}

/**
 * Admin routes for API token lifecycle.
 *   POST   /api-tokens         — create (returns raw token ONCE)
 *   GET    /api-tokens         — list (raw tokens never returned)
 *   DELETE /api-tokens/:id     — revoke
 *
 * Mounted under /api/admin by the root router. These routes are currently
 * unauthenticated (project convention: admin UI is localhost). When that
 * changes, add a middleware on this sub-router.
 */
export function createApiTokensRouter(bundle: AuthBundle): Hono {
  const app = new Hono();

  app.post('/api-tokens', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as CreateTokenBody;
    const name = typeof body.name === 'string' ? body.name : '';
    if (!name.trim()) return c.json({ error: 'name is required' }, 400);

    const scopes = Array.isArray(body.scopes) && body.scopes.every((s) => typeof s === 'string')
      ? (body.scopes as string[])
      : ['mcp:read', 'mcp:write'];
    const expiresInDays = typeof body.expiresInDays === 'number' && body.expiresInDays > 0
      ? body.expiresInDays
      : undefined;

    const out = bundle.issueApiToken.execute({ name, scopes, expiresInDays });
    bundle.audit.execute({
      principal: out.id,
      tokenType: 'api_token',
      event: 'token_issued',
      status: 201,
      toolName: null,
      meta: { name, scopes, expiresInDays: expiresInDays ?? null },
    });
    return c.json({ id: out.id, rawToken: out.rawToken }, 201);
  });

  app.get('/api-tokens', (c) => {
    const tokens = bundle.listApiTokens.execute().map((t) => ({
      id: t.id,
      name: t.name,
      scopes: t.scopes.values(),
      expires_at: t.expiresAt,
      created_at: t.createdAt,
      last_used_at: t.lastUsedAt,
      revoked_at: t.revokedAt,
      // token_hash is intentionally NOT returned
    }));
    return c.json({ tokens });
  });

  app.delete('/api-tokens/:id', (c) => {
    const id = c.req.param('id');
    bundle.revokeApiToken.execute(id);
    bundle.audit.execute({
      principal: id,
      tokenType: 'api_token',
      event: 'token_revoked',
      status: 204,
      toolName: null,
      meta: {},
    });
    return c.body(null, 204);
  });

  return app;
}
