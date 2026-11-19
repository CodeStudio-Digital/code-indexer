import type { ProviderDefinition, ProviderCredentials, ResolvedCreds, StoredOAuth } from '../types.js';
import type { ProviderConfig } from '@mcp/store/provider-store.js';
import {
  resolveCopilotCreds,
  resolveChatGPTCreds,
  resolveGoogleOAuthCreds,
  resolveClaudeCodeCreds,
  runOAuthRefresh,
} from './oauth.js';
import { resolveBedrockCreds } from './aws.js';
import { getStore } from './store.js';

function toStoredOAuth(row: ReturnType<NonNullable<ReturnType<typeof getStore>>['getOAuth']>): StoredOAuth | null {
  if (!row) return null;
  return {
    access_token: row.access_token,
    refresh_token: row.refresh_token,
    expires_at: row.expires_at,
    scope: row.scope,
    extra: row.extra ?? {},
  };
}

function providerCredentials(cfg: ProviderConfig): ProviderCredentials {
  return {
    async get() {
      const store = getStore();
      return toStoredOAuth(store?.getOAuth(cfg.id) ?? null);
    },
    async set(tokens) {
      const store = getStore();
      if (!store) throw new Error('Provider credential store is not available');
      store.setOAuth({
        provider_id: cfg.id,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: tokens.expires_at,
        scope: tokens.scope,
        extra: tokens.extra,
      });
    },
    async mirrorApiKey(token) {
      const store = getStore();
      if (!store) throw new Error('Provider credential store is not available');
      const latest = store.getProvider(cfg.id) ?? cfg;
      store.upsertProvider({ ...latest, api_key: token });
    },
    async clear() {
      const store = getStore();
      if (!store) throw new Error('Provider credential store is not available');
      store.deleteOAuth(cfg.id);
    },
  };
}

/**
 * Whether to route this kind through the data-driven generic OAuth path
 * (`runOAuthRefresh`) instead of the legacy per-kind switch. Read at CALL time
 * (workers are long-lived) so the staged cutover can flip a kind without a
 * restart. Default OFF → the legacy path is untouched. `MCP_GENERIC_OAUTH=1`
 * enables it; an optional `MCP_GENERIC_OAUTH_KINDS=a,b` scopes it per-kind.
 */
function genericOAuthEnabled(kind: string): boolean {
  if (process.env.MCP_GENERIC_OAUTH !== '1') return false;
  const list = process.env.MCP_GENERIC_OAUTH_KINDS?.trim();
  if (!list) return true;
  return list.split(',').map((s) => s.trim()).includes(kind);
}

/**
 * Resolve runtime credentials for a provider instance. Despachado por
 * credKind: api-key reads the DB row only; oauth refreshes via the shared
 * OAuth helpers; aws reads the AWS block from oauth_tokens.extra.
 *
 * Credentials are never sourced from the environment — the provider
 * configuration (admin UI / `provider_configs` row) is the sole source. With
 * no row, an api-key shape resolves to `apiKey: undefined` and the downstream
 * call fails with a clear auth error rather than silently using an env token.
 *
 * cfg=null means "no DB row" — for api-key that yields no key; aws falls back
 * to the instance-role SDK chain. OAuth shapes require a cfg.
 */
export async function resolveCreds(
  def: ProviderDefinition,
  cfg: ProviderConfig | null,
): Promise<ResolvedCreds> {
  if (def.kind === 'copilot') {
    // Older Cloud profiles keep their token until the SDK login succeeds.
    if (cfg && (cfg.api_key || getStore()?.getOAuth(cfg.id))) return resolveCopilotCreds(cfg);
    return { extra: cfg?.extra ?? {} };
  }
  if (def.resolveCredentials) {
    if (!cfg) {
      throw new Error(
        `Provider '${def.kind}' requires a ProviderStore row for plugin-owned credential resolution.`,
      );
    }
    return def.resolveCredentials({
      config: cfg,
      credentials: providerCredentials(cfg),
      resolveHostCredentials:
        def.kind === 'claude-code' ? () => resolveClaudeCodeCreds(cfg) : undefined,
      fetch,
      log: (message) => console.warn(`[provider:${def.kind}] ${message}`),
    });
  }

  switch (def.credKind) {
    case 'api-key':
      return {
        apiKey: cfg?.api_key ?? undefined,
        baseURL: cfg?.base_url ?? def.defaultBaseURL,
        // Forward the cfg.extra blob so api-key shapes that need
        // per-instance config (e.g. Cloudflare's account_id) can read it
        // off ResolvedCreds.extra without a kind-specific branch here.
        extra: cfg?.extra,
      };

    case 'oauth':
      if (!cfg) {
        throw new Error(
          `OAuth provider '${def.kind}' requires a ProviderStore row. ` +
          `Configure it via the admin UI first.`,
        );
      }
      // Generic OAuth seam (default OFF). When enabled for this kind it routes
      // through the data-driven dispatch, which for the 5 connectors delegates
      // to the SAME resolve*Creds below — so the legacy path stays the fallback
      // and behavior is identical until per-kind E2E flips a kind on.
      if (genericOAuthEnabled(def.kind)) return runOAuthRefresh(def, cfg);
      if (def.kind === 'chatgpt') return resolveChatGPTCreds(cfg);
      if (def.kind === 'google-oauth') return resolveGoogleOAuthCreds(cfg);
      if (def.kind === 'claude-code') return resolveClaudeCodeCreds(cfg);
      throw new Error(`Unknown OAuth shape: ${def.kind}`);

    case 'aws':
      if (!cfg) {
        // No row — let SDK default credential chain take over
        return { aws: {} };
      }
      return resolveBedrockCreds(cfg);
  }
}
