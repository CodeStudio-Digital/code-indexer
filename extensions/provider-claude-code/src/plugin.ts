import { definePlugin } from '@mcp/plugin-sdk/define.js';
import { defineProviderAdapterFromSpec } from '@mcp/provider-runtime/plugin-adapter.js';
import { claudeCodeSpec } from './spec.js';

export const providerAdapter = defineProviderAdapterFromSpec(claudeCodeSpec, {
  resolveCredentials: async ({ config }) => {
    const { resolveClaudeCodeCreds } = await import('@mcp/services/providers/shared/oauth.js');
    return resolveClaudeCodeCreds(config as Parameters<typeof resolveClaudeCodeCreds>[0]);
  },
});

export default definePlugin({ providers: [claudeCodeSpec] });
