import type { ProviderDefinition, ResolvedCreds } from '../types.js';
import type { ProviderConfig } from '@mcp/store/provider-store.js';
import {
  resolveCopilotCreds,
  resolveChatGPTCreds,
  resolveGoogleOAuthCreds,
  resolveClaudeCodeCreds,
  resolveKimiCodeCreds,
} from './oauth.js';
import { resolveBedrockCreds } from './aws.js';

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
      if (def.kind === 'copilot') return resolveCopilotCreds(cfg);
      if (def.kind === 'chatgpt') return resolveChatGPTCreds(cfg);
      if (def.kind === 'google-oauth') return resolveGoogleOAuthCreds(cfg);
      if (def.kind === 'claude-code') return resolveClaudeCodeCreds(cfg);
      if (def.kind === 'kimi-code') return resolveKimiCodeCreds(cfg);
      throw new Error(`Unknown OAuth shape: ${def.kind}`);

    case 'aws':
      if (!cfg) {
        // No row — let SDK default credential chain take over
        return { aws: {} };
      }
      return resolveBedrockCreds(cfg);
  }
}
