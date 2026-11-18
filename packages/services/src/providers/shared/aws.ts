import { resolveAwsConfigCredentials } from '@mcp/provider-sdk';
import type { ProviderConfig } from '@mcp/store/provider-store.js';
import { getStore } from './store.js';

export function resolveBedrockCreds(cfg: ProviderConfig) {
  return resolveAwsConfigCredentials(cfg, { get: async () => getStore()?.getOAuth(cfg.id) ?? null });
}
