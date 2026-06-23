import { defineProvider } from '../types.js';
import { AnthropicProvider } from '@mcp/indexer/indexer/providers/anthropic.js';
import { AnthropicChatProvider } from '@mcp/code-agent/providers/anthropic.js';

export const anthropic = defineProvider({
  kind: 'anthropic',
  displayName: 'Anthropic (Claude)',
  visual: { icon: 'Sparkles', fg: 'text-orange-500', bg: 'bg-orange-500/15' },
  credKind: 'api-key',
  envVars: ['ANTHROPIC_API_KEY'],
  // Preferred default when only a provider (no model) is given. Sonnet, not
  // the cheaper haiku that leads `defaultModels` (used for the picker list).
  defaultModel: 'claude-sonnet-4-6',
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
    new AnthropicProvider(creds.apiKey, model, creds.baseURL, {
      // Cheap default for summary-only analysis. Override via
      // `extra.summary_model` on the provider row when picking a different
      // cheap variant (e.g. a future haiku release).
      summaryModel:
        typeof creds.extra?.summary_model === 'string'
          ? creds.extra.summary_model
          : 'claude-haiku-4-5-20251001',
    }),
  createCoder: (creds, model) =>
    new AnthropicChatProvider({
      apiKey: creds.apiKey,
      baseURL: creds.baseURL,
      model: model ?? 'claude-sonnet-4-6',
      // Extended thinking config consumed when `req.thinking === true`. The
      // adapter auto-bumps `max_tokens` to ensure `max_tokens > budget_tokens`
      // (API requirement) so callers don't need to also set max_tokens here.
      defaultThinking: { type: 'enabled', budget_tokens: 32000 },
    }),
  testConnection: async ({ creds }) => {
    const base = (creds.baseURL ?? 'https://api.anthropic.com').replace(/\/$/, '');
    const r = await fetch(`${base}/v1/models`, {
      headers: { 'x-api-key': creds.apiKey ?? '', 'anthropic-version': '2023-06-01' },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  },
});
