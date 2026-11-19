import type { DiscoveryResult } from './types.js';
export type { DiscoveryResult } from './types.js';
import type { ProviderSpec } from '@mcp/provider-sdk';
import type { ProviderConfig, ProviderStore, UpsertModelInput } from '@mcp/store/provider-store.js';
import { discoverOpenAIModels } from './openai-models.js';
import { discoverAnthropicModels } from './anthropic-models.js';
import { discoverGeminiModels } from './gemini-models.js';
import { discoverOpenrouterModels } from './openrouter-models.js';
import { discoverCloudflareModels } from './cloudflare-models.js';
import { discoverChatgptModels } from './chatgpt-models.js';
import { discoverCopilotModels } from './copilot-models.js';
import { discoverKimiCodeModels } from './kimi-code-models.js';
import { discoverClaudeCodeModels } from './claude-code-models.js';
import { discoverGoogleOAuthModels } from './google-oauth-models.js';
import { discoverBedrockModels } from './bedrock-models.js';


/**
 * Live model discovery, driven by `spec.discovery.from`. Each format builder
 * owns the provider-specific catalog mapping for its discovery protocol.
 *
 * `store` is required by the OAuth/sdk formats (they refresh tokens). `previousEtag`
 * is threaded into chatgpt-models only — it is the sole ETag/304 producer and so
 * returns a full DiscoveryResult directly; every other format yields a model list
 * that is wrapped to `{etag:null, notModified:false}`. `static` → no live list.
 */
export async function discoverModels(
  spec: ProviderSpec,
  cfg: ProviderConfig,
  store?: ProviderStore,
  previousEtag?: string | null,
): Promise<DiscoveryResult> {
  const from = spec.discovery?.from ?? 'static';
  switch (from) {
    case 'openai-models':
      return wrap(await discoverOpenAIModels(spec, cfg));
    case 'anthropic-models':
      return wrap(await discoverAnthropicModels(spec, cfg));
    case 'gemini-models':
      return wrap(await discoverGeminiModels(spec, cfg));
    case 'openrouter-models':
      return wrap(await discoverOpenrouterModels(spec, cfg));
    case 'cloudflare-models':
      return wrap(await discoverCloudflareModels(spec, cfg));
    case 'chatgpt-models':
      // The only ETag/304 producer — returns a full DiscoveryResult.
      return discoverChatgptModels(spec, cfg, previousEtag ?? null);
    case 'sdk:copilot':
      return wrap(await discoverCopilotModels(spec, cfg, store));
    case 'sdk:kimi-code':
      return wrap(await discoverKimiCodeModels(spec, cfg, requireStore(store, from)));
    case 'sdk:claude-code':
      return wrap(await discoverClaudeCodeModels(spec, cfg, requireStore(store, from)));
    case 'sdk:google-oauth':
      return wrap(await discoverGoogleOAuthModels(spec, cfg, requireStore(store, from)));
    case 'sdk:bedrock':
      return wrap(await discoverBedrockModels(spec, cfg, requireStore(store, from)));
    case 'static':
      return wrap([]);
    default:
      throw new Error(`provider-engine: discovery '${from}' not implemented for '${spec.kind}'`);
  }
}

function wrap(models: UpsertModelInput[]): DiscoveryResult {
  return { models, etag: null, notModified: false };
}

function requireStore(store: ProviderStore | undefined, from: string): ProviderStore {
  if (!store) throw new Error(`provider-engine: discovery '${from}' requires a ProviderStore`);
  return store;
}
