/**
 * Generic /oauth/:providerId — list connection status and disconnect.
 *
 * Provider-specific flows (copilot device flow, openai PKCE, bedrock creds)
 * live in sibling files and are mounted at separate prefixes by admin/index.
 */
import { HttpRouter } from '@mcp/shared/http/router.js';
import type { ProviderStore } from '@mcp/store/provider-store.js';
import { maskKey } from './shared/mask.js';

export function oauthRouter(store: ProviderStore): HttpRouter {
  const app = new HttpRouter();

  app.get('/oauth/:providerId', (c) => {
    const t = store.getOAuth(c.req.param('providerId'));
    if (!t) return c.json({ connected: false });
    // Mask the access token and the stored GitHub PAT — the UI only needs
    // to show connection status + expiry, never the raw secret.
    return c.json({
      connected: true,
      access_token_masked: maskKey(t.access_token),
      has_refresh: !!t.refresh_token,
      refresh_token_masked: maskKey(t.refresh_token),
      expires_at: t.expires_at,
      expires_in_seconds: t.expires_at
        ? Math.max(0, Math.floor((t.expires_at - Date.now()) / 1000))
        : null,
      scope: t.scope,
      extra: t.extra,
    });
  });

  app.delete('/oauth/:providerId', (c) => {
    store.deleteOAuth(c.req.param('providerId'));
    return c.json({ ok: true });
  });

  return app;
}
