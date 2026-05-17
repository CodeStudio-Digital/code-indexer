/**
 * GitHub Copilot device flow — /oauth/copilot/start + /poll.
 *
 * Start is stateless — we don't persist the device_code; it lives on
 * GitHub's side for ~15 min and the UI keeps it. Poll exchanges the GitHub
 * PAT for a Copilot token on success, upserts the provider row (creating it
 * on-the-fly for enterprise/individual editions), stores both tokens, and
 * kicks off a best-effort model refresh so the UI has models immediately.
 */
import { Hono } from 'hono';
import type { ProviderStore } from '@mcp/store/provider-store.js';
import {
  startDeviceFlow,
  pollDeviceFlow,
  exchangeForCopilotToken,
  type CopilotEdition,
} from '@mcp/services/services/oauth/copilot.js';
import { parseCopilotOpts } from './shared/copilot-opts.js';
import { discoverModels } from './model-discovery/index.js';

export function copilotOAuthRouter(store: ProviderStore): Hono {
  const app = new Hono();

  /**
   * Start the GitHub device flow. The UI shows user_code + verification_uri;
   * the user opens the URL, types the code, and the UI polls /poll below.
   */
  app.post('/oauth/copilot/start', async (c) => {
    try {
      const body = await c.req.json<unknown>().catch(() => ({}));
      const opts = parseCopilotOpts(body);
      const flow = await startDeviceFlow(opts);
      // Echo the resolved opts back so the UI can attach them to the poll
      // request verbatim without tracking state across the two calls.
      return c.json({ ...flow, opts });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
  });

  /**
   * Poll a device flow. Called by the dashboard on an interval until status
   * flips to 'authorized', at which point we exchange the GitHub PAT for a
   * Copilot token and persist both. The provider row (kind='copilot') is
   * created on-the-fly if it doesn't exist yet — the UI doesn't have to
   * create the provider before starting OAuth.
   */
  app.post('/oauth/copilot/poll', async (c) => {
    const body = await c.req.json<{
      device_code: string;
      provider_id?: string;
      opts?: unknown;
      edition?: CopilotEdition;
      ghes_host?: string;
      integration_id?: string;
      client_id?: string;
    }>();
    if (!body.device_code) return c.json({ error: 'device_code required' }, 400);
    // Enterprise connections get their own provider row so individual +
    // enterprise can coexist side-by-side.
    const opts = parseCopilotOpts(body.opts ?? body);
    const providerId =
      body.provider_id ?? (opts.edition === 'enterprise' ? 'copilot-enterprise' : 'copilot');

    try {
      const result = await pollDeviceFlow(body.device_code, opts);
      if (result.status !== 'authorized') {
        return c.json(result);
      }

      // User approved. Exchange the GitHub PAT for a Copilot API token.
      const copilot = await exchangeForCopilotToken(result.access_token, opts);

      // Prefer the API endpoint the token exchange published; fall back to
      // the public default for individual or construct from ghes_host for
      // enterprise (not always published by older GHES versions).
      const apiBase =
        copilot.endpoints?.api ??
        (opts.edition === 'enterprise' && opts.ghes_host
          ? `https://${opts.ghes_host.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`
          : 'https://api.githubcopilot.com');

      // Make sure the provider row exists — upsert with sensible defaults.
      if (!store.getProvider(providerId)) {
        store.upsertProvider({
          id: providerId,
          name:
            opts.edition === 'enterprise'
              ? `GitHub Copilot (Enterprise${opts.ghes_host ? ` · ${opts.ghes_host}` : ''})`
              : 'GitHub Copilot',
          kind: 'copilot',
          base_url: apiBase,
          api_key: copilot.token, // Mirrored so createChatProviderFromConfig works before refresh.
          auth_mode: 'oauth',
          enabled: true,
          use_for_coder: true,
          use_for_agent: false, // Copilot's pricing model isn't friendly for indexing loops.
          extra: { copilot_opts: opts },
        });
      } else {
        // Refresh the api_key mirror + opts so the coder adapter and
        // model discovery see the new token/edition. use_for_agent is
        // preserved — admin can enable indexing for Copilot.
        const existing = store.getProvider(providerId)!;
        store.upsertProvider({
          ...existing,
          api_key: copilot.token,
          base_url: apiBase,
          extra: { ...existing.extra, copilot_opts: opts },
        });
      }

      store.setOAuth({
        provider_id: providerId,
        access_token: copilot.token,
        refresh_token: result.access_token, // GitHub PAT used for re-exchange.
        expires_at: copilot.expires_at,
        scope: result.scope,
        extra: { ...copilot.extra, copilot_opts: opts },
      });

      // Kick off a best-effort model refresh so the UI has models to show
      // the moment the dialog flips to 'success'. Non-fatal on failure.
      let model_count = 0;
      try {
        const fresh = store.getProvider(providerId)!;
        const result = await discoverModels(store, fresh);
        if (!result.notModified) {
          store.replaceModelsFromSource(providerId, 'live', result.models);
          store.setProviderCatalogEtag(providerId, result.etag);
        }
        model_count = result.models.length;
      } catch (e) {
        console.warn(`[copilot] initial model discovery failed: ${(e as Error).message}`);
      }

      return c.json({
        status: 'authorized',
        provider_id: providerId,
        expires_at: copilot.expires_at,
        model_count,
      });
    } catch (e) {
      return c.json({ status: 'error', error: (e as Error).message }, 502);
    }
  });

  return app;
}
