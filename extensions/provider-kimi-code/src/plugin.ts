import { definePlugin } from '@mcp/plugin-sdk/define.js';
import { defineProviderAdapterFromSpec } from '@mcp/provider-runtime/plugin-adapter.js';
import {
  logoutKimiCodeAuth,
  pollKimiCodeAuth,
  resolveKimiCodeCredentials,
  startKimiCodeAuth,
} from './auth.js';
import { discoverKimiCodeModels } from './discovery.js';
import { kimiCodeSpec } from './spec.js';

export const providerAdapter = defineProviderAdapterFromSpec(kimiCodeSpec, {
  authHandlers: {
    start: startKimiCodeAuth,
    poll: pollKimiCodeAuth,
    refresh: (ctx) => resolveKimiCodeCredentials(ctx),
    logout: logoutKimiCodeAuth,
  },
  resolveCredentials: resolveKimiCodeCredentials,
  discoverModels: discoverKimiCodeModels,
});

export default definePlugin({ providers: [kimiCodeSpec] });
