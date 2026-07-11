import { definePlugin } from '@mcp/plugin-sdk/define.js';
import { defineProviderAdapterFromSpec } from '@mcp/provider-runtime/plugin-adapter.js';
import { claudeCodeSpec } from './spec.js';

export const providerAdapter = defineProviderAdapterFromSpec(claudeCodeSpec, {
  resolveCredentials: async ({ resolveHostCredentials }) => {
    if (!resolveHostCredentials) {
      throw new Error('Claude Code host credential resolver is unavailable');
    }
    return resolveHostCredentials();
  },
});

export default definePlugin({ providers: [claudeCodeSpec] });
