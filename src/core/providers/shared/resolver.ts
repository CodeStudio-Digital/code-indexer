import type { ProviderDefinition, ResolvedCreds } from '../types.js';
import type { ProviderConfig } from '../../../store/provider-store.js';
import { resolveCopilotCreds, resolveChatGPTCreds, resolveGoogleOAuthCreds } from './oauth.js';
import { resolveBedrockCreds } from './aws.js';

/**
 * Pick the first defined env var from a list.
 */
function pickEnv(envVars: string[]): string | undefined {
  for (const v of envVars) {
    const val = process.env[v];
    if (val) return val;
  }
  return undefined;
}

/**
 * Resolve runtime credentials for a provider instance. Despachado por
 * credKind: api-key reads DB row or env; oauth refreshes via the shared
 * OAuth helpers; aws reads the AWS block from oauth_tokens.extra.
 *
 * cfg=null means "no DB row" — only legal for api-key with env var set,
 * or for aws with instance-role fallback. OAuth shapes require a cfg.
 */
export async function resolveCreds(
  def: ProviderDefinition,
  cfg: ProviderConfig | null,
): Promise<ResolvedCreds> {
  switch (def.credKind) {
    case 'api-key':
      return {
        apiKey: cfg?.api_key ?? pickEnv(def.envVars),
        baseURL: cfg?.base_url ?? def.defaultBaseURL,
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
      throw new Error(`Unknown OAuth shape: ${def.kind}`);

    case 'aws':
      if (!cfg) {
        // No row — let SDK default credential chain take over
        return { aws: {} };
      }
      return resolveBedrockCreds(cfg);
  }
}
