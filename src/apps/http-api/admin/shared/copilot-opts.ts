/**
 * Copilot OAuth request parsing + API base URL resolution.
 *
 * Both `/oauth/copilot/start` and `/poll` accept the same `{edition, ghes_host,
 * integration_id, client_id}` shape, so `parseCopilotOpts` stays lenient about
 * missing fields. `resolveCopilotApiBase` prefers the endpoint the token
 * exchange published, then provider_configs.base_url, then the public default.
 */
import type { ProviderStore, ProviderConfig } from '../../../../store/provider-store.js';
import type {
  CopilotOAuthOptions,
  CopilotEdition,
} from '../../../../core/services/oauth/copilot.js';

export function parseCopilotOpts(body: unknown): CopilotOAuthOptions {
  const b = (body ?? {}) as {
    edition?: CopilotEdition;
    ghes_host?: string;
    integration_id?: string;
    client_id?: string;
  };
  const edition: CopilotEdition = b.edition === 'enterprise' ? 'enterprise' : 'individual';
  return {
    edition,
    ghes_host: b.ghes_host,
    integration_id: b.integration_id,
    client_id: b.client_id,
  };
}

export function resolveCopilotApiBase(store: ProviderStore, cfg: ProviderConfig): string {
  const tok = store.getOAuth(cfg.id);
  const extra = (tok?.extra ?? {}) as { endpoints?: Record<string, string> };
  const fromExchange = extra.endpoints?.api;
  const base = fromExchange ?? cfg.base_url ?? 'https://api.githubcopilot.com';
  return base.replace(/\/$/, '');
}
