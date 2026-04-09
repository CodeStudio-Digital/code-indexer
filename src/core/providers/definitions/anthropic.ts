import { defineProvider } from '../types.js';
import { AnthropicProvider } from '../../indexer/providers/anthropic.js';
import { AnthropicChatProvider } from '../../coder/providers/anthropic.js';

export const anthropic = defineProvider({
  kind: 'anthropic',
  displayName: 'Anthropic (Claude)',
  credKind: 'api-key',
  envVars: ['ANTHROPIC_API_KEY'],
  defaultModels: [
    'claude-haiku-4-5-20251001',
    'claude-sonnet-4-6-20260320',
    'claude-opus-4-6-20260320',
  ],
  pricing: {
    'claude-haiku-4-5-20251001':  { inputPer1M: 0.80, outputPer1M: 4.00 },
    'claude-sonnet-4-6-20260320': { inputPer1M: 3.00, outputPer1M: 15.00 },
    'claude-opus-4-6-20260320':   { inputPer1M: 15.00, outputPer1M: 75.00 },
  },
  capabilities: { supportsThinking: true, supportsVision: true },
  createIndexer: (creds, model) =>
    new AnthropicProvider(creds.apiKey, model, creds.baseURL),
  createCoder: (creds, model) =>
    new AnthropicChatProvider({
      apiKey: creds.apiKey,
      baseURL: creds.baseURL,
      model: model ?? 'claude-sonnet-4-6',
    }),
});
