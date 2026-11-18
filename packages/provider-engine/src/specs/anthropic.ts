import type { ProviderSpec } from '@mcp/provider-sdk';

/**
 * Declarative spec for the Anthropic (Claude) built-in. Provider-specific
 * runtime constants live in `wireOpts` data:
 *   - `defaultThinking` — legacy extended-thinking fallback for Haiku/unknown
 *     models. Current adaptive models are resolved per request by the wire.
 *   - `summaryModelDefault` — the cheap default model for summary-only indexing
 *     (overridable via `extra.summary_model` on the provider row).
 *
 * No `defaultBaseURL` — the Anthropic adapter defaults the base URL internally.
 */
export const anthropicSpec: ProviderSpec = {
  kind: 'anthropic',
  displayName: 'Anthropic Compatible',
  visual: { icon: 'Sparkles', fg: 'text-orange-500', bg: 'bg-orange-500/15' },
  credKind: 'api-key',
  envVars: ['ANTHROPIC_API_KEY'],
  // Preferred default when only a provider (no model) is given.
  defaultModel: 'claude-sonnet-5',
  defaultModels: [
    'claude-fable-5',
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-haiku-4-5-20251001',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
  ],
  pricing: {
    'claude-fable-5': { inputPer1M: 10.0, outputPer1M: 50.0 },
    'claude-opus-5': { inputPer1M: 5.0, outputPer1M: 25.0 },
    'claude-sonnet-5': { inputPer1M: 3.0, outputPer1M: 15.0 },
    'claude-haiku-4-5-20251001': { inputPer1M: 1.0, outputPer1M: 5.0 },
    'claude-opus-4-8': { inputPer1M: 5.0, outputPer1M: 25.0 },
    'claude-opus-4-7': { inputPer1M: 5.0, outputPer1M: 25.0 },
    'claude-opus-4-6': { inputPer1M: 5.0, outputPer1M: 25.0 },
    'claude-sonnet-4-6': { inputPer1M: 3.0, outputPer1M: 15.0 },
  },
  models: {
    'claude-fable-5': {
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      defaultReasoningLevel: 'high',
      supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    'claude-opus-5': {
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      defaultReasoningLevel: 'high',
      supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    'claude-sonnet-5': {
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      defaultReasoningLevel: 'high',
      supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    'claude-haiku-4-5-20251001': {
      contextWindow: 200_000,
      maxTokens: 32_000,
      defaultReasoningLevel: null,
      supportedReasoningLevels: null,
    },
    'claude-opus-4-8': {
      contextWindow: 1_000_000,
      maxTokens: 64_000,
      defaultReasoningLevel: 'high',
      supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    'claude-opus-4-7': {
      contextWindow: 1_000_000,
      maxTokens: 64_000,
      defaultReasoningLevel: 'xhigh',
      supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    'claude-opus-4-6': {
      contextWindow: 200_000,
      maxTokens: 64_000,
      defaultReasoningLevel: 'high',
      supportedReasoningLevels: ['low', 'medium', 'high', 'max'],
    },
    'claude-sonnet-4-6': {
      contextWindow: 200_000,
      maxTokens: 32_000,
      defaultReasoningLevel: 'high',
      supportedReasoningLevels: ['low', 'medium', 'high', 'max'],
    },
  },
  capabilities: { supportsThinking: true, supportsVision: true, fileInput: 'pdf-only' },
  wire: 'anthropic',
  wireOpts: {
    defaultThinking: { type: 'enabled', budget_tokens: 32000 },
    summaryModelDefault: 'claude-haiku-4-5-20251001',
  },
  discovery: { from: 'anthropic-models' },
  test: { from: 'anthropic-models', fallbackBaseURL: 'https://api.anthropic.com' },
};

export const ANTHROPIC_SPECS: ProviderSpec[] = [anthropicSpec];
