import type { ProviderSpec } from '@mcp/provider-sdk';

/**
 * Declarative spec for the Anthropic (Claude) built-in. Metadata mirrors the
 * hand-written `services/.../definitions/anthropic.ts` exactly (the equivalence
 * test asserts it); the per-instance constants become `wireOpts` data:
 *   - `defaultThinking` — static extended-thinking config the coder passes to
 *     the adapter (consumed when `req.thinking === true`).
 *   - `summaryModelDefault` — the cheap default model for summary-only indexing
 *     (overridable via `extra.summary_model` on the provider row).
 *
 * No `defaultBaseURL` — the Anthropic adapter defaults the base URL internally,
 * so the definition omits it and so must the spec (the equivalence test compares
 * `undefined === undefined`).
 */
export const anthropicSpec: ProviderSpec = {
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
    'claude-haiku-4-5-20251001': { inputPer1M: 0.8, outputPer1M: 4.0 },
    'claude-sonnet-4-6-20260320': { inputPer1M: 3.0, outputPer1M: 15.0 },
    'claude-opus-4-6-20260320': { inputPer1M: 15.0, outputPer1M: 75.0 },
  },
  capabilities: { supportsThinking: true, supportsVision: true },
  wire: 'anthropic',
  wireOpts: {
    defaultThinking: { type: 'enabled', budget_tokens: 32000 },
    summaryModelDefault: 'claude-haiku-4-5-20251001',
  },
  discovery: { from: 'anthropic-models' },
  test: { from: 'anthropic-models', fallbackBaseURL: 'https://api.anthropic.com' },
};

export const ANTHROPIC_SPECS: ProviderSpec[] = [anthropicSpec];
