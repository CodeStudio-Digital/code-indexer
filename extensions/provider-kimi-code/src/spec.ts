import type { ProviderSpec } from '@mcp/provider-sdk';

/**
 * Declarative spec for the API-key-only Kimi Code built-in. The inline
 * `readKimiCodeThinkingMode` logic is represented as `wireOpts.thinkingMode`
 * data the engine interprets.
 *
 * `KIMI_CODE_BASE_URL` (`'https://api.kimi.com/coding/v1'`) and the seed model
 * ids are inlined here so the plugin carries its own declarative metadata.
 */

export const KIMI_CODE_BASE_URL = 'https://api.kimi.com/coding/v1';

const KIMI_CODE_SEED_MODEL_IDS = [
  'k3',
  'k3-256k',
  'kimi-for-coding',
  'kimi-for-coding-highspeed',
];

export const kimiCodeSpec: ProviderSpec = {
  kind: 'kimi-code',
  displayName: 'Kimi Code',
  visual: { icon: 'Bot', fg: 'text-cyan-500', bg: 'bg-cyan-500/15' },
  credKind: 'api-key',
  envVars: ['KIMI_CODE_API_KEY'],
  defaultBaseURL: KIMI_CODE_BASE_URL,
  defaultModel: 'kimi-for-coding',
  defaultModels: KIMI_CODE_SEED_MODEL_IDS,
  pricing: {
    'k3': { inputPer1M: 0.0, outputPer1M: 0.0 },
    'k3-256k': { inputPer1M: 0.0, outputPer1M: 0.0 },
    'kimi-for-coding': { inputPer1M: 0.0, outputPer1M: 0.0 },
    'kimi-for-coding-highspeed': { inputPer1M: 0.0, outputPer1M: 0.0 },
    'kimi-k2.6': { inputPer1M: 0.0, outputPer1M: 0.0 },
    'kimi-k2.5': { inputPer1M: 0.0, outputPer1M: 0.0 },
    'kimi-k2-thinking': { inputPer1M: 0.0, outputPer1M: 0.0 },
    'kimi-k2-thinking-turbo': { inputPer1M: 0.0, outputPer1M: 0.0 },
    'kimi-k2-turbo-preview': { inputPer1M: 0.0, outputPer1M: 0.0 },
  },
  // Wins the cross-provider duplicate-id collision with moonshot (default 0)
  // for the shared coding-model ids. Deterministic once BOTH are plugins.
  pricingPriority: -10,
  capabilities: {
    supportsThinking: true,
    supportsVision: true,
  },
  wire: 'kimi',
  wireOpts: {
    thinkingMode: { from: 'extra', key: 'thinkingMode', default: 'auto' },
  },
  discovery: { from: 'sdk:kimi-code' },
  test: { from: 'sdk:kimi-code' },
  // The thinking-mode key matches wireOpts.thinkingMode.key ('thinkingMode').
  config: {
    fields: [
      {
        key: 'thinkingMode',
        type: 'select',
        label: 'Thinking mode',
        storeIn: 'extra',
        options: [
          { value: 'auto', label: 'Auto' },
          { value: 'enabled', label: 'Enabled' },
          { value: 'disabled', label: 'Disabled' },
        ],
        default: 'auto',
      },
    ],
  },
  models: {
    k3: kimiK3Model(1_048_576, true),
    'k3-256k': kimiK3Model(262_144, false),
    'kimi-for-coding': kimiCodingAliasModel(),
    'kimi-for-coding-highspeed': kimiCodingAliasModel(),
  },
};

export const KIMI_SPECS: ProviderSpec[] = [kimiCodeSpec];

function kimiK3Model(contextWindow: number, supportsVideo: boolean) {
  return {
    contextWindow,
    maxTokens: 32_000,
    canReason: true,
    supportsAttachments: true,
    supportedReasoningLevels: ['low', 'high', 'max'],
    defaultReasoningLevel: 'high',
    inputModalities: supportsVideo ? ['text', 'image', 'video'] : ['text', 'image'],
  };
}

function kimiCodingAliasModel() {
  return {
    contextWindow: 262_144,
    maxTokens: 32_000,
    canReason: true,
    supportsAttachments: true,
    supportedReasoningLevels: null,
    defaultReasoningLevel: null,
    inputModalities: ['text', 'image', 'video'],
  };
}
