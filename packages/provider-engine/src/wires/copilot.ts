import type { ProviderDefinition, ProviderSpec } from '@mcp/provider-sdk';
import { CopilotSdkProvider } from '@mcp/code-agent/providers/copilot-sdk.js';
import { listCopilotModels } from '../discovery/copilot-models.js';
import { buildOpenAICompat } from './openai-compat.js';
import { buildTestConnection } from '../wire-helpers/test-connection.js';

export function buildCopilot(spec: ProviderSpec): Pick<ProviderDefinition, 'createCoder' | 'testConnection'> {
  const legacySpec: ProviderSpec = {
    ...spec, wire: 'openai-compat', wireOpts: { vendor: 'copilot' },
    defaultModel: 'gpt-5.6-terra', test: { from: 'openai-models', fallbackBaseURL: 'https://api.githubcopilot.com' },
  };
  const legacy = buildOpenAICompat(legacySpec);
  const legacyTest = buildTestConnection(legacySpec)!;
  return {
    createCoder: (creds, model, opts) => creds.apiKey !== undefined
      ? legacy.createCoder!(creds, model, opts)
      : new CopilotSdkProvider(opts?.providerId ?? 'copilot', model, creds.extra),
    testConnection: async ctx => {
      if (ctx.creds.apiKey !== undefined) return legacyTest(ctx);
      await listCopilotModels(ctx.config.id, ctx.config.extra ?? {});
    },
  };
}
