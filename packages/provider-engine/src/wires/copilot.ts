import type { ProviderDefinition } from '@mcp/provider-sdk';
import { CopilotSdkProvider } from '@mcp/code-agent/providers/copilot-sdk.js';
import { listCopilotModels } from '../discovery/copilot-models.js';

export function buildCopilot(): Pick<ProviderDefinition, 'createCoder' | 'testConnection'> {
  return {
    createCoder: (_creds, model, opts) => new CopilotSdkProvider(opts?.providerId ?? 'copilot', model),
    testConnection: async ({ config }) => { await listCopilotModels(config.id); },
  };
}
