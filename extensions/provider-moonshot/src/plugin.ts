import { definePlugin } from '@mcp/plugin-sdk/define.js';
import { defineProviderAdapterFromSpec } from '@mcp/provider-runtime/plugin-adapter.js';
import { resolveApiKeyConfigCredentials } from '@mcp/provider-sdk';
import { moonshotSpec } from './spec.js';

export const providerAdapter = defineProviderAdapterFromSpec(moonshotSpec, {
  resolveCredentials: async ({ config }) => resolveApiKeyConfigCredentials(config, moonshotSpec.defaultBaseURL),
});

export default definePlugin({ providers: [moonshotSpec] });
