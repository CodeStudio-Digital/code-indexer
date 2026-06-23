import { defineProvider } from '../types.js';
import { GeminiProvider } from '@mcp/indexer/indexer/providers/gemini.js';
import { GeminiChatProvider } from '@mcp/code-agent/providers/gemini.js';

export const gemini = defineProvider({
  kind: 'gemini',
  displayName: 'Google Gemini',
  visual: { icon: 'Zap', fg: 'text-sky-500', bg: 'bg-sky-500/15' },
  credKind: 'api-key',
  envVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  // 2.5-flash, not the 2.0-flash that leads the list — 2.0-flash's free quota
  // is 0 as of April 2026 and returns 429 immediately for a bare provider pick.
  defaultModel: 'gemini-2.5-flash',
  defaultModels: ['gemini-2.0-flash', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
  pricing: {
    'gemini-2.0-flash':      { inputPer1M: 0.00, outputPer1M: 0.00 },
    'gemini-2.5-pro':        { inputPer1M: 1.25, outputPer1M: 10.00 },
    'gemini-2.5-flash':      { inputPer1M: 0.00, outputPer1M: 0.00 },
    'gemini-2.5-flash-lite': { inputPer1M: 0.00, outputPer1M: 0.00 },
  },
  capabilities: { supportsThinking: true, supportsVision: true },
  createIndexer: (creds, model) => new GeminiProvider(creds.apiKey, model),
  createCoder: (creds, model) =>
    new GeminiChatProvider({
      apiKey: creds.apiKey,
      model: model ?? 'gemini-2.5-flash',
    }),
  testConnection: async ({ creds }) => {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(creds.apiKey ?? '')}`,
    );
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  },
});
