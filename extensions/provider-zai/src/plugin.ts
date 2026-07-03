import { definePlugin } from '@mcp/plugin-sdk/define.js';
import { defineProviderAdapterFromSpec } from '@mcp/provider-runtime/plugin-adapter.js';
import { resolveApiKeyConfigCredentials } from '@mcp/provider-sdk';
import { zaiSpec } from './spec.js';

export const providerAdapter = defineProviderAdapterFromSpec(zaiSpec, {
  resolveCredentials: async ({ config }) => resolveApiKeyConfigCredentials(config, zaiSpec.defaultBaseURL),
});

export default definePlugin({ providers: [zaiSpec] });
