import { Hono } from 'hono';
import type { AuthBundle } from '../auth/composition.js';
import type { IndexerConfig } from '../../../utils/config.js';
import type { GrantType, TokenEndpointAuthMethod } from '../../../core/auth/domain/oauth-client.js';

interface DcrBody {
  client_name?: unknown;
  redirect_uris?: unknown;
  grant_types?: unknown;
  scope?: unknown;
  token_endpoint_auth_method?: unknown;
}

const VALID_GRANTS: readonly GrantType[] = ['authorization_code', 'refresh_token'];
const VALID_AUTH_METHODS: readonly TokenEndpointAuthMethod[] = ['none', 'client_secret_basic', 'client_secret_post'];

/**
 * Dynamic Client Registration (RFC 7591).
 * Disabled via `MCP_OAUTH_ALLOW_DCR=false`. Defaults public (PKCE-only).
 */
export function createRegisterRouter(bundle: AuthBundle, config: IndexerConfig): Hono {
  const app = new Hono();

  app.post('/register', async (c) => {
    if (!config.mcp.oauth.allowDcr) {
      return c.json({ error: 'dcr_disabled' }, 404);
    }

    const body = (await c.req.json().catch(() => ({}))) as DcrBody;

    const clientName = typeof body.client_name === 'string' ? body.client_name : '';
    if (!clientName.trim()) return c.json({ error: 'invalid_client_metadata', error_description: 'client_name required' }, 400);

    const redirectUris = Array.isArray(body.redirect_uris) && body.redirect_uris.every((u) => typeof u === 'string')
      ? (body.redirect_uris as string[])
      : [];
    if (redirectUris.length === 0) {
      return c.json({ error: 'invalid_redirect_uri', error_description: 'At least one redirect_uri required' }, 400);
    }

    const rawGrants = Array.isArray(body.grant_types) ? body.grant_types : VALID_GRANTS;
    const grantTypes = rawGrants.filter((g): g is GrantType => typeof g === 'string' && (VALID_GRANTS as readonly string[]).includes(g));
    if (grantTypes.length === 0) {
      return c.json({ error: 'invalid_client_metadata', error_description: 'Unsupported grant_types' }, 400);
    }

    const scopes = typeof body.scope === 'string'
      ? body.scope.split(' ').filter(Boolean)
      : ['mcp:read', 'mcp:write'];

    const authMethod = typeof body.token_endpoint_auth_method === 'string'
      && (VALID_AUTH_METHODS as readonly string[]).includes(body.token_endpoint_auth_method)
      ? body.token_endpoint_auth_method as TokenEndpointAuthMethod
      : 'none';

    const out = bundle.registerOAuthClient.execute({
      clientName, redirectUris, grantTypes, scopes, tokenEndpointAuthMethod: authMethod,
    });

    bundle.audit.execute({
      principal: out.clientId,
      tokenType: 'oauth',
      event: 'client_registered',
      status: 201,
      toolName: null,
      meta: { clientName, authMethod },
    });

    return c.json({
      client_id: out.clientId,
      client_secret: out.clientSecret ?? undefined,
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: grantTypes,
      scope: scopes.join(' '),
      token_endpoint_auth_method: authMethod,
    }, 201);
  });

  return app;
}
