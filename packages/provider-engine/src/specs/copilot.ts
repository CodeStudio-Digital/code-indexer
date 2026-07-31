import type { ProviderSpec } from '@mcp/provider-sdk';

/**
 * GitHub Copilot — OpenAI-compatible wire, OAuth credentials. The 25-min token,
 * base URL (instance/enterprise), and editor headers are produced upstream by
 * `resolveCopilotCreds`; here the wire just builds the adapter from the
 * resolved creds.
 */
export const copilotSpec: ProviderSpec = {
  kind: 'copilot',
  displayName: 'GitHub Copilot',
  visual: { icon: 'Code2', fg: 'text-purple-500', bg: 'bg-purple-500/15' },
  credKind: 'oauth',
  envVars: [],
  defaultModel: 'gpt-5.6-terra',
  defaultModels: [
    'gpt-5.6-terra',
    'gpt-5.6-sol',
    'gpt-5.6-luna',
    'claude-sonnet-5',
    'claude-opus-5',
    'claude-fable-5',
    'gemini-3.6-flash',
    'kimi-k2.7',
  ],
  pricing: {},
  capabilities: { supportsThinking: true, supportsVision: true },
  wire: 'openai-compat',
  wireOpts: { vendor: 'copilot', indexerDefaultModel: 'gpt-5.6-luna' },
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
  models: {
    'gpt-5.6-terra': copilotReasoningModel(),
    'gpt-5.6-sol': copilotReasoningModel(),
    'gpt-5.6-luna': copilotReasoningModel(),
    'claude-sonnet-5': copilotReasoningModel(),
    'claude-opus-5': copilotReasoningModel(),
    'claude-fable-5': copilotReasoningModel(),
    'gemini-3.6-flash': {
      canReason: true,
      supportsAttachments: true,
      supportedReasoningLevels: null,
      defaultReasoningLevel: null,
    },
    'kimi-k2.7': {
      canReason: true,
      supportsAttachments: true,
      supportedReasoningLevels: null,
      defaultReasoningLevel: null,
    },
  },
};

export const COPILOT_SPECS: ProviderSpec[] = [copilotSpec];

function copilotReasoningModel() {
  return {
    canReason: true,
    supportsAttachments: true,
    supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultReasoningLevel: 'medium',
  };
}
