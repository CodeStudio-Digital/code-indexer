import { Hono } from 'hono';
import type { AuthBundle } from '../auth/composition.js';

/**
 * Admin list/revoke for OAuth clients (registered via DCR or manually).
 * Revocation is idempotent; `revoked_at` guards double-revoke.
 */
export function createOAuthClientsRouter(bundle: AuthBundle): Hono {
  const app = new Hono();

  app.get('/oauth-clients', (c) => {
    const clients = bundle.listOAuthClients.execute().map((cli) => ({
      client_id: cli.clientId,
      client_name: cli.clientName,
      redirect_uris: cli.redirectUris,
      grant_types: cli.grantTypes,
      scopes: cli.scopes.values(),
      token_endpoint_auth_method: cli.tokenEndpointAuthMethod,
      created_at: cli.createdAt,
      revoked_at: cli.revokedAt,
    }));
    return c.json({ clients });
  });

  app.delete('/oauth-clients/:id', (c) => {
    const id = c.req.param('id');
    bundle.revokeOAuthClient.execute(id);
    bundle.audit.execute({
      principal: id,
      tokenType: 'oauth',
      event: 'client_revoked',
      status: 204,
      toolName: null,
      meta: {},
    });
    return c.body(null, 204);
  });

  return app;
}
