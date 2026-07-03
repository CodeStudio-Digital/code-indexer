import { definePlugin } from '@mcp/plugin-sdk/define.js';
import { defineProviderAdapterFromSpec } from '@mcp/provider-runtime/plugin-adapter.js';
import { resolveApiKeyConfigCredentials } from '@mcp/provider-sdk';
import { fuguSpec } from './spec.js';

export const providerAdapter = defineProviderAdapterFromSpec(fuguSpec, {
  resolveCredentials: async ({ config }) => resolveApiKeyConfigCredentials(config, fuguSpec.defaultBaseURL),
});

export default definePlugin({ providers: [fuguSpec] });
