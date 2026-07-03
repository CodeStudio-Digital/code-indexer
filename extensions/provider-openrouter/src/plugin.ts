import { definePlugin } from '@mcp/plugin-sdk/define.js';
import { defineProviderAdapterFromSpec } from '@mcp/provider-runtime/plugin-adapter.js';
import { resolveApiKeyConfigCredentials } from '@mcp/provider-sdk';
import { openrouterSpec } from './spec.js';

export const providerAdapter = defineProviderAdapterFromSpec(openrouterSpec, {
  resolveCredentials: async ({ config }) => resolveApiKeyConfigCredentials(config, openrouterSpec.defaultBaseURL),
});

export default definePlugin({ providers: [openrouterSpec] });
