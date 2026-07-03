import { definePlugin } from '@mcp/plugin-sdk/define.js';
import { defineProviderAdapterFromSpec } from '@mcp/provider-runtime/plugin-adapter.js';
import { resolveApiKeyConfigCredentials } from '@mcp/provider-sdk';
import { cloudflareSpec } from './spec.js';

export const providerAdapter = defineProviderAdapterFromSpec(cloudflareSpec, {
  resolveCredentials: async ({ config }) => resolveApiKeyConfigCredentials(config, cloudflareSpec.defaultBaseURL),
});

export default definePlugin({ providers: [cloudflareSpec] });
