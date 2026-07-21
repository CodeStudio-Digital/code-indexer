import { definePlugin } from '@mcp/plugin-sdk/define.js';
import { defineProviderAdapterFromSpec } from '@mcp/provider-runtime/plugin-adapter.js';
import { discoverKimiCodeModels } from './discovery.js';
import { kimiCodeSpec } from './spec.js';

export const providerAdapter = defineProviderAdapterFromSpec(kimiCodeSpec, {
  discoverModels: discoverKimiCodeModels,
});

export default definePlugin({ providers: [kimiCodeSpec] });
