import type { ProviderSpec } from '@mcp/provider-sdk';

/**
 * Moonshot AI (api-key) — same wire as kimi-code (KimiCodeChatProvider), only
 * auth shape + base URL differ. The thinking mode is read from a DIFFERENT
 * extra key (`kimi_code_thinking_mode`) than kimi-code's (`thinkingMode`).
 * Mirrors `services/.../definitions/moonshot.ts` exactly.
 */
export const moonshotSpec: ProviderSpec = {
  kind: 'moonshot',
  displayName: 'Moonshot AI (API key)',
  visual: { icon: 'Bot', fg: 'text-cyan-400', bg: 'bg-cyan-400/15' },
  credKind: 'api-key',
  envVars: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
  defaultBaseURL: 'https://api.moonshot.ai/v1',
  defaultModels: [
    'kimi-k2-0711-preview',
    'kimi-k2-turbo-preview',
    'kimi-k2-thinking-turbo',
    'kimi-latest',
    'moonshot-v1-auto',
    'moonshot-v1-128k',
    'moonshot-v1-32k',
    'moonshot-v1-8k',
  ],
  pricing: {
    'kimi-k2-0711-preview': { inputPer1M: 0.6, outputPer1M: 2.5 },
    'kimi-k2-turbo-preview': { inputPer1M: 0.6, outputPer1M: 2.5 },
    'kimi-k2-thinking-turbo': { inputPer1M: 0.6, outputPer1M: 2.5 },
    'kimi-latest': { inputPer1M: 0.6, outputPer1M: 2.5 },
    'moonshot-v1-8k': { inputPer1M: 0.2, outputPer1M: 2.0 },
    'moonshot-v1-32k': { inputPer1M: 1.0, outputPer1M: 3.0 },
    'moonshot-v1-128k': { inputPer1M: 2.0, outputPer1M: 5.0 },
    'moonshot-v1-auto': { inputPer1M: 1.0, outputPer1M: 3.0 },
  },
  capabilities: { supportsThinking: true, supportsVision: true },
  wire: 'kimi',
  wireOpts: { thinkingMode: { from: 'extra', key: 'kimi_code_thinking_mode', default: 'auto' } },
  discovery: { from: 'openai-models', filterPrefixes: ['kimi-', 'moonshot-'] },
  // The thinking-mode key matches wireOpts.thinkingMode.key ('kimi_code_thinking_mode').
  config: {
    fields: [
      {
        key: 'kimi_code_thinking_mode',
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
};

export const MOONSHOT_SPECS: ProviderSpec[] = [moonshotSpec];
