/**
 * OAuth 2.1 client flow for external MCP servers.
 *
 * Routes are mounted under /api/admin. The flow is initiated by the
 * dashboard, which opens the returned authorizationUrl in a popup. The
 * callback renders a tiny HTML page that posts the outcome back via
 * window.opener.postMessage, then closes itself.
 *
 * Mounted on top of the existing `mcpServersRouter` (migration 015) —
 * this router only adds the new OAuth-specific paths.
 */
import { Hono } from 'hono';
import type { McpClientAuthBundle } from '@mcp/services/mcp-client/auth/composition.js';
import type { AuthorizationServerMetadata } from '@mcp/services/mcp-client/auth/domain/authorization-server.js';
import {
  mcpAuthClientErrorMessage,
  type McpAuthClientError,
} from '@mcp/services/mcp-client/auth/domain/errors.js';

export function createMcpServersOauthRouter(
  bundle: McpClientAuthBundle,
  publicBaseUrl: () => string,
): Hono {
  const app = new Hono();

  function redirectUriFor(serverId: string): string {
    // In the socket-free Electron shell the dashboard's own origin has no
    // HTTP listener, so the desktop main process points OAuth redirects at
    // an ephemeral 127.0.0.1 loopback (RFC 8252) via MCP_OAUTH_REDIRECT_BASE.
    // The web deployment leaves it unset and uses its real public origin.
    const base = process.env.MCP_OAUTH_REDIRECT_BASE ?? publicBaseUrl();
    return `${base}/api/admin/mcp-servers/${serverId}/oauth/callback`;
  }

  function errorStatus(kind: McpAuthClientError['kind']): 400 | 404 | 502 {
    if (kind === 'server_not_found' || kind === 'registration_not_found' || kind === 'tokens_not_found') return 404;
    if (kind === 'discovery_failed' || kind === 'dcr_failed' || kind === 'token_exchange_failed' || kind === 'refresh_failed') return 502;
    return 400;
  }

  /**
   * GET  /mcp-servers/:id/oauth/status
   * Reports whether the server has a registration and (via `connected`)
   * whether consent has completed — the dashboard polls `connected`
   * because the OAuth callback lands in an external browser and can't
   * postMessage back into the desktop window.
   */
  app.get('/mcp-servers/:id/oauth/status', (c) => {
    const serverId = c.req.param('id');
    const reg = bundle.registrationAdminRepo.listAll().find((r) => r.serverId === serverId);
    // Reader would be cleaner but adminRepo.listAll is already available here.
    const status = reg ? 'registered' : 'not_registered';
    const tokens = bundle.tokensReaderRepo.findByServerId(serverId);
    return c.json({
      server_id: serverId,
      status,
      connected: tokens !== null,
      expires_at: tokens?.accessExpiresAt ?? null,
      registration: reg
        ? {
            issuer: reg.issuer,
            client_id: reg.clientId,
            scopes: reg.scopes,
            redirect_uri: reg.redirectUri,
            source: reg.registrationSource,
          }
        : null,
    });
  });

  /**
   * POST /mcp-servers/:id/oauth/discover
   * Body: { resource_url: string }
   * Returns the resolved AS metadata.
   */
  app.post('/mcp-servers/:id/oauth/discover', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { resource_url?: unknown };
    const resourceUrl = typeof body.resource_url === 'string' ? body.resource_url : '';
    if (!resourceUrl) return c.json({ error: 'resource_url required' }, 400);

    const result = await bundle.discover.execute({ resourceUrl });
    if (!result.ok) {
      return c.json(
        { error: result.error.kind, error_description: mcpAuthClientErrorMessage(result.error) },
        errorStatus(result.error.kind),
      );
    }
    return c.json({ resource: result.value.resource, as: result.value.as });
  });

  /**
   * POST /mcp-servers/:id/oauth/register
   * Body: either DCR input { resource_url, client_name?, scopes? }
   *       or manual input { as: AuthorizationServerMetadata, client_id, client_secret?, scopes? }
   */
  app.post('/mcp-servers/:id/oauth/register', async (c) => {
    const serverId = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const redirectUri = redirectUriFor(serverId);

    // Manual branch: user provided client credentials out-of-band.
    if (typeof body.client_id === 'string' && body.client_id) {
      const as = body.as as AuthorizationServerMetadata | undefined;
      if (!as) return c.json({ error: 'as metadata required for manual registration' }, 400);
      const scopes = stringArrayOr(body.scopes, ['mcp:read', 'mcp:write']);
      const clientSecret = typeof body.client_secret === 'string' ? body.client_secret : null;
      const reg = bundle.registerManual.execute({
        serverId,
        asMetadata: as,
        clientId: body.client_id,
        clientSecret,
        redirectUri,
        scopes,
      });
      return c.json({ client_id: reg.clientId, source: 'manual' }, 201);
    }

    // DCR branch: start with discovery.
    const resourceUrl = typeof body.resource_url === 'string' ? body.resource_url : '';
    if (!resourceUrl) return c.json({ error: 'resource_url or client_id required' }, 400);

    const discovered = await bundle.discover.execute({ resourceUrl });
    if (!discovered.ok) {
      return c.json(
        { error: discovered.error.kind, error_description: mcpAuthClientErrorMessage(discovered.error) },
        errorStatus(discovered.error.kind),
      );
    }

    const clientName = typeof body.client_name === 'string' && body.client_name
      ? body.client_name
      : `mcp-coder-${serverId}`;
    // Default scopes come from the PR metadata first (most specific), then
    // the AS metadata, and only fall back to the generic mcp:read/write
    // pair when the server declared nothing. Hardcoding mcp:read/write
    // breaks providers like Figma (`mcp:connect`) and Clerk-style servers
    // (`email`, `profile`, …) that reject unknown scopes.
    const discoveredScopes =
      discovered.value.resource.scopesSupported.length > 0
        ? discovered.value.resource.scopesSupported
        : discovered.value.as.scopesSupported;
    const scopes = stringArrayOr(
      body.scopes,
      discoveredScopes.length > 0 ? [...discoveredScopes] : ['mcp:read', 'mcp:write'],
    );

    const registered = await bundle.registerDynamic.execute({
      serverId,
      asMetadata: discovered.value.as,
      clientName,
      redirectUri,
      scopes,
    });
    if (!registered.ok) {
      // Surface the discovered AS so the dashboard can offer a manual
      // registration path (some providers — e.g. Figma — advertise a
      // registration_endpoint but only accept pre-registered clients).
      return c.json(
        {
          error: registered.error.kind,
          error_description: mcpAuthClientErrorMessage(registered.error),
          as: discovered.value.as,
          scopes_supported: discoveredScopes,
        },
        errorStatus(registered.error.kind),
      );
    }
    return c.json({ client_id: registered.value.clientId, source: 'dcr' }, 201);
  });

  /**
   * POST /mcp-servers/:id/oauth/authorize
   * Returns authorization_url for the dashboard to open in a popup.
   */
  app.post('/mcp-servers/:id/oauth/authorize', (c) => {
    const serverId = c.req.param('id');
    const result = bundle.startFlow.execute({ serverId });
    if (!result.ok) {
      return c.json(
        { error: result.error.kind, error_description: mcpAuthClientErrorMessage(result.error) },
        errorStatus(result.error.kind),
      );
    }
    return c.json({ authorization_url: result.value.authorizationUrl, state: result.value.state });
  });

  /**
   * GET /mcp-servers/:id/oauth/callback
   * Handles the AS redirect. Renders a tiny HTML page that posts the
   * outcome back to the opener window and closes.
   */
  app.get('/mcp-servers/:id/oauth/callback', async (c) => {
    const q = c.req.query();
    if (q.error) {
      return c.html(renderCallback({ ok: false, error: q.error, description: q.error_description }));
    }
    if (!q.code || !q.state) {
      return c.html(renderCallback({ ok: false, error: 'invalid_request', description: 'missing code/state' }));
    }

    const result = await bundle.completeFlow.execute({ code: q.code, state: q.state });
    if (!result.ok) {
      return c.html(renderCallback({
        ok: false,
        error: result.error.kind,
        description: mcpAuthClientErrorMessage(result.error),
      }));
    }
    return c.html(renderCallback({ ok: true, serverId: result.value.serverId, scopes: result.value.scopes }));
  });

  /**
   * POST /mcp-servers/:id/oauth/refresh — manual refresh for diagnostics.
   */
  app.post('/mcp-servers/:id/oauth/refresh', async (c) => {
    const serverId = c.req.param('id');
    const result = await bundle.refreshAccess.execute({ serverId });
    if (!result.ok) {
      return c.json(
        { error: result.error.kind, error_description: mcpAuthClientErrorMessage(result.error) },
        errorStatus(result.error.kind),
      );
    }
    return c.json({ ok: true, expires_at: result.value.expiresAt });
  });

  /**
   * DELETE /mcp-servers/:id/oauth — revoke + local purge.
   */
  app.delete('/mcp-servers/:id/oauth', async (c) => {
    const serverId = c.req.param('id');
    await bundle.revoke.execute(serverId);
    return c.body(null, 204);
  });

  return app;
}

function stringArrayOr(v: unknown, fallback: string[]): string[] {
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  return fallback;
}

interface CallbackOk { ok: true; serverId: string; scopes: readonly string[]; }
interface CallbackErr { ok: false; error: string; description?: string; }
type CallbackResult = CallbackOk | CallbackErr;

function renderCallback(r: CallbackResult): string {
  const payload = r.ok
    ? { ok: true, server_id: r.serverId, scopes: r.scopes }
    : { ok: false, error: r.error, error_description: r.description ?? '' };
  const esc = (s: string) => s.replace(/</g, '&lt;');
  const title = r.ok ? 'Connected' : 'Authorization failed';
  const message = r.ok
    ? `Server <code>${esc(r.serverId)}</code> connected with scopes: <code>${esc(r.scopes.join(' '))}</code>`
    : `Error: <code>${esc(r.error)}</code><br><small>${esc(r.description ?? '')}</small>`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui;max-width:480px;margin:4rem auto;padding:0 1rem;color:#333}
.ok{color:#0a7}.err{color:#c33}</style></head>
<body>
<h1 class="${r.ok ? 'ok' : 'err'}">${title}</h1>
<p>${message}</p>
<p><small>You can close this window.</small></p>
<script>
  (function(){
    try {
      if (window.opener) window.opener.postMessage(${JSON.stringify(payload)}, '*');
    } catch (e) { /* ignore */ }
    setTimeout(function(){ try { window.close(); } catch (e) {} }, 500);
  })();
</script>
</body></html>`;
}
