import { definePlugin } from '@mcp/plugin-sdk/define.js';
import { defineProviderAdapterFromSpec } from '@mcp/provider-runtime/plugin-adapter.js';
import {
  logoutCopilotAuth,
  pollCopilotAuth,
  resolveCopilotCredentials,
  startCopilotAuth,
} from './auth.js';
import { discoverCopilotModels } from './discovery.js';
import { copilotSpec } from './spec.js';

export const providerAdapter = defineProviderAdapterFromSpec(copilotSpec, {
  authHandlers: {
    start: startCopilotAuth,
    poll: pollCopilotAuth,
    refresh: (ctx) => resolveCopilotCredentials(ctx),
    logout: logoutCopilotAuth,
  },
  resolveCredentials: resolveCopilotCredentials,
  discoverModels: discoverCopilotModels,
});

export default definePlugin({ providers: [copilotSpec] });
