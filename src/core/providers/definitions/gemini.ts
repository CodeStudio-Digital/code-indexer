import { defineProvider } from '../types.js';
import { GeminiProvider } from '../../indexer/providers/gemini.js';
import { GeminiChatProvider } from '../../coder/providers/gemini.js';

export const gemini = defineProvider({
  kind: 'gemini',
  displayName: 'Google Gemini',
  credKind: 'api-key',
  envVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  defaultModels: ['gemini-2.0-flash', 'gemini-2.5-pro', 'gemini-2.5-flash'],
  pricing: {
    'gemini-2.0-flash': { inputPer1M: 0.00, outputPer1M: 0.00 },
    'gemini-2.5-pro':   { inputPer1M: 1.25, outputPer1M: 10.00 },
    'gemini-2.5-flash': { inputPer1M: 0.00, outputPer1M: 0.00 },
  },
  capabilities: { supportsThinking: true, supportsVision: true },
  createIndexer: (creds, model) => new GeminiProvider(creds.apiKey, model),
  createCoder: (creds, model) =>
    new GeminiChatProvider({
      apiKey: creds.apiKey,
      model: model ?? 'gemini-2.5-flash',
    }),
});
