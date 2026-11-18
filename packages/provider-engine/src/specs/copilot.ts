import type { ProviderSpec } from '@mcp/provider-sdk';

export const copilotSpec: ProviderSpec = {
  kind: 'copilot',
  displayName: 'GitHub Copilot',
  visual: { icon: 'Code2', fg: 'text-purple-500', bg: 'bg-purple-500/15' },
  credKind: 'oauth',
  envVars: [],
  defaultModels: [],
  pricing: {},
  capabilities: { supportsThinking: true, supportsVision: true },
  wire: 'copilot',
  discovery: { from: 'sdk:copilot' },
};

export const COPILOT_SPECS: ProviderSpec[] = [copilotSpec];
