import type { ProviderSpec } from '@mcp/provider-sdk';

/**
 * GitHub Copilot — OpenAI-compatible wire, OAuth credentials. The 25-min token,
 * base URL (instance/enterprise), and editor headers are produced upstream by
 * `resolveCopilotCreds` (the OAuth refresh path lands in the OAuth-engine phase);
 * here the wire just builds the adapter from the resolved creds, exactly like
 * `services/.../definitions/copilot.ts`.
 */
export const copilotSpec: ProviderSpec = {
  kind: 'copilot',
  displayName: 'GitHub Copilot',
  visual: { icon: 'Code2', fg: 'text-purple-500', bg: 'bg-purple-500/15' },
  credKind: 'oauth',
  envVars: [],
  defaultModels: ['gpt-4o', 'gpt-4o-mini', 'claude-3.5-sonnet', 'o1-mini'],
  pricing: {
    'gpt-4o': { inputPer1M: 0.0, outputPer1M: 0.0 },
    'gpt-4o-mini': { inputPer1M: 0.0, outputPer1M: 0.0 },
    'claude-3.5-sonnet': { inputPer1M: 0.0, outputPer1M: 0.0 },
    'o1-mini': { inputPer1M: 0.0, outputPer1M: 0.0 },
  },
  wire: 'openai-compat',
  wireOpts: { indexerDefaultModel: 'gpt-4o' },
  discovery: { from: 'sdk:copilot' },
  test: { from: 'openai-models', fallbackBaseURL: 'https://api.githubcopilot.com' },
  // Declarative OAuth (pat-exchange: GitHub device-code → long-lived PAT, then the
  // 'copilot' hook exchanges the PAT for a ~25min editor token + resolves the
  // instance base URL/endpoints). Values inlined from services/oauth/copilot.ts.
  auth: {
    mode: 'oauth',
    flavor: 'pat-exchange',
    scopes: ['read:user'],
    needs: { deviceCode: true },
    clientId: '01ab8ac9400c4e429b23',
    deviceAuthUrl: 'https://github.com/login/device/code',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    hooks: 'copilot',
  },
};

export const COPILOT_SPECS: ProviderSpec[] = [copilotSpec];
