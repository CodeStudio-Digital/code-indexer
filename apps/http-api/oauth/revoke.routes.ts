import { Hono } from 'hono';
import type { AuthBundle } from '../auth/composition.js';

/**
 * RFC 7009 token revocation. Always returns 200 (per spec, never 401) to
 * avoid leaking whether a token existed. Only refresh tokens are stateful;
 * access tokens (JWTs) just expire.
 */
export function createRevokeRouter(bundle: AuthBundle): Hono {
  const app = new Hono();

  app.post('/revoke', async (c) => {
    const body = await c.req.parseBody();
    const token = typeof body.token === 'string' ? body.token : '';
    if (token) bundle.revokeOAuthToken.execute(token);
    return c.body(null, 200);
  });

  return app;
}
