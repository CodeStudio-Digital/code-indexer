import { defineProvider } from '../types.js';
import { KimiCodeProvider } from '../../indexer/providers/kimi-code.js';
import { KimiCodeChatProvider } from '../../coder/providers/kimi-code.js';
import {
  KIMI_CODE_BASE_URL,
  KIMI_CODE_SEED_MODELS,
} from '../../services/oauth/kimi-code.js';

export const kimiCode = defineProvider({
  kind: 'kimi-code',
  displayName: 'Kimi Code (OAuth)',
  credKind: 'oauth',
  envVars: [],
  defaultBaseURL: KIMI_CODE_BASE_URL,
  defaultModels: KIMI_CODE_SEED_MODELS.map((m) => m.model_id),
  pricing: {
    'kimi-k2.6': { inputPer1M: 0.00, outputPer1M: 0.00 },
    'kimi-k2.5': { inputPer1M: 0.00, outputPer1M: 0.00 },
    'kimi-k2-thinking': { inputPer1M: 0.00, outputPer1M: 0.00 },
    'kimi-k2-thinking-turbo': { inputPer1M: 0.00, outputPer1M: 0.00 },
    'kimi-k2-turbo-preview': { inputPer1M: 0.00, outputPer1M: 0.00 },
  },
  capabilities: {
    supportsThinking: true,
    supportsVision: true,
  },
  createIndexer: (creds, model) =>
    new KimiCodeProvider(
      creds.apiKey,
      model ?? 'kimi-k2.6',
      creds.baseURL ?? KIMI_CODE_BASE_URL,
      creds.extraHeaders,
    ),
  createCoder: (creds, model) =>
    new KimiCodeChatProvider({
      apiKey: creds.apiKey,
      baseURL: creds.baseURL ?? KIMI_CODE_BASE_URL,
      model: model ?? 'kimi-k2.6',
      defaultHeaders: creds.extraHeaders,
      thinkingMode: readKimiCodeThinkingMode(creds.extra?.thinkingMode),
    }),
});

function readKimiCodeThinkingMode(value: unknown): 'auto' | 'enabled' | 'disabled' {
  return value === 'enabled' || value === 'disabled' || value === 'auto'
    ? value
    : 'auto';
}
