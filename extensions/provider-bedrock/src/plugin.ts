import { definePlugin } from '@mcp/plugin-sdk/define.js';
import { defineProviderAdapterFromSpec } from '@mcp/provider-runtime/plugin-adapter.js';
import { resolveAwsConfigCredentials } from '@mcp/provider-sdk';
import { bedrockSpec } from './spec.js';

export const providerAdapter = defineProviderAdapterFromSpec(bedrockSpec, {
  resolveCredentials: ({ config, credentials }) => resolveAwsConfigCredentials(config, credentials),
});

export default definePlugin({ providers: [bedrockSpec] });
