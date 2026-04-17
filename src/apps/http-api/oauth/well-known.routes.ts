import { Hono } from 'hono';
import type { IndexerConfig } from '../../../utils/config.js';

/**
 * Discovery endpoints required by the MCP Authorization spec (2025-03-26).
 *
 * - /.well-known/oauth-protected-resource  (RFC 9728)
 * - /.well-known/oauth-authorization-server (RFC 8414)
 *
 * Mount at the app root so the well-known prefix stays standard. Issuer
 * URL is read from config; `issuer` MUST be the public base URL of the
 * deployment for metadata self-consistency.
 */
export function createWellKnownRouter(config: IndexerConfig): Hono {
  const app = new Hono();

  app.get('/.well-known/oauth-protected-resource', (c) => {
    const issuer = config.mcp.oauth.issuer || publicBaseUrl(c.req.url);
    return c.json({
      resource: issuer,
      authorization_servers: [issuer],
      scopes_supported: ['mcp:read', 'mcp:write', 'mcp:admin'],
      bearer_methods_supported: ['header'],
      resource_documentation: `${issuer}/docs`,
    });
  });

  app.get('/.well-known/oauth-authorization-server', (c) => {
    const issuer = config.mcp.oauth.issuer || publicBaseUrl(c.req.url);
    return c.json({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      registration_endpoint: config.mcp.oauth.allowDcr ? `${issuer}/oauth/register` : undefined,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['mcp:read', 'mcp:write', 'mcp:admin'],
    });
  });

  return app;
}

function publicBaseUrl(requestUrl: string): string {
  const u = new URL(requestUrl);
  return `${u.protocol}//${u.host}`;
}
