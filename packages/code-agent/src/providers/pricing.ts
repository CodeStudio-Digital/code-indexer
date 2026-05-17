/**
 * Per-model pricing for cost estimation in telemetry.
 *
 * Prices are USD per 1,000,000 tokens. Cache-read pricing reflects the
 * provider's discounted rate when a cached prefix hits (Anthropic ~10%,
 * OpenAI ~50%, Gemini varies). Cache-write reflects the one-time premium
 * Anthropic charges to populate the cache. Providers without a cache
 * column omit it (treated as full input price).
 *
 * This file intentionally lives next to model-registry.ts so adding a
 * model in one place is a strong nudge to add pricing in the other.
 * If a model is missing from this table, estimateCost returns 0 (we
 * never block telemetry on missing prices) and logs once per process.
 *
 * Sources are checked at the time of writing; treat as a snapshot. UI
 * always shows "estimated" so users know it's not a billing source.
 */
export interface ModelPricing {
  /** USD per 1M input tokens (full price). */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** USD per 1M cache-read input tokens (when prompt cache hits). */
  cacheRead?: number;
  /** USD per 1M cache-creation input tokens (Anthropic write). */
  cacheWrite?: number;
}

/**
 * Match by exact model id first, then by prefix. The prefix table covers
 * "claude-haiku-4-5-20251001" → "claude-haiku-4-5" so dated variants
 * inherit pricing without needing a row each.
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // ── Anthropic ───────────────────────────────────────────────────────────
  'claude-opus-4-7':            { input: 15.0, output: 75.0, cacheRead: 1.5,  cacheWrite: 18.75 },
  'claude-opus-4-6':            { input: 15.0, output: 75.0, cacheRead: 1.5,  cacheWrite: 18.75 },
  'claude-sonnet-4-6':          { input: 3.0,  output: 15.0, cacheRead: 0.3,  cacheWrite: 3.75  },
  'claude-haiku-4-5':           { input: 0.8,  output: 4.0,  cacheRead: 0.08, cacheWrite: 1.0   },

  // ── OpenAI ──────────────────────────────────────────────────────────────
  'gpt-5':                      { input: 1.25, output: 10.0, cacheRead: 0.125 },
  'gpt-5.5':                    { input: 1.25, output: 10.0, cacheRead: 0.125 },
  'gpt-5-mini':                 { input: 0.25, output: 2.0,  cacheRead: 0.025 },
  'gpt-4o':                     { input: 2.5,  output: 10.0, cacheRead: 1.25  },
  'gpt-4o-mini':                { input: 0.15, output: 0.6,  cacheRead: 0.075 },
  'gpt-4-turbo':                { input: 10.0, output: 30.0 },
  'o1':                         { input: 15.0, output: 60.0, cacheRead: 7.5   },
  'o1-mini':                    { input: 3.0,  output: 12.0, cacheRead: 1.5   },
  'o3-mini':                    { input: 1.1,  output: 4.4,  cacheRead: 0.55  },

  // ── ZAI / GLM ───────────────────────────────────────────────────────────
  'glm-5.1':                    { input: 0.6,  output: 2.2 },
  'glm-4.7-flash':              { input: 0.1,  output: 0.4 },
  'glm-4.6':                    { input: 0.6,  output: 2.2 },
  'glm-4.5':                    { input: 0.6,  output: 2.2 },
  'glm-4.5-air':                { input: 0.2,  output: 1.1 },
  'glm-4.5-x':                  { input: 1.0,  output: 4.0 },
  'glm-4.5-airx':               { input: 0.4,  output: 1.6 },
  'glm-4.5-flash':              { input: 0.1,  output: 0.4 },

  // ── DeepSeek (V4, 2026 pricing — input cache-miss vs cache-hit) ────────
  'deepseek-v4-flash':          { input: 0.27, output: 1.1,  cacheRead: 0.07 },
  'deepseek-v4-pro':            { input: 0.55, output: 2.2,  cacheRead: 0.14 },
  'deepseek-chat':              { input: 0.27, output: 1.1,  cacheRead: 0.07 },
  'deepseek-coder':             { input: 0.27, output: 1.1,  cacheRead: 0.07 },
  'deepseek-reasoner':          { input: 0.55, output: 2.2,  cacheRead: 0.14 },

  // ── Kimi ────────────────────────────────────────────────────────────────
  'kimi-k2.6':                  { input: 0.6,  output: 2.5,  cacheRead: 0.15 },
  'kimi-k2.5':                  { input: 0.6,  output: 2.5,  cacheRead: 0.15 },
  'kimi-k2-thinking':           { input: 0.6,  output: 2.5,  cacheRead: 0.15 },
  'kimi-k2-thinking-turbo':     { input: 1.0,  output: 4.0,  cacheRead: 0.25 },
  'kimi-k2-turbo-preview':      { input: 1.0,  output: 4.0,  cacheRead: 0.25 },

  // ── Gemini ──────────────────────────────────────────────────────────────
  'gemini-2.5-flash':           { input: 0.3,  output: 2.5,  cacheRead: 0.075 },
  'gemini-2.5-pro':             { input: 1.25, output: 10.0, cacheRead: 0.31  },
  'gemini-2.0-flash':           { input: 0.1,  output: 0.4,  cacheRead: 0.025 },
  'gemini-2.0-flash-lite':      { input: 0.075, output: 0.3 },
  'gemini-1.5-pro':             { input: 1.25, output: 5.0,  cacheRead: 0.31  },
  'gemini-1.5-flash':           { input: 0.075, output: 0.3, cacheRead: 0.019 },
};

const PREFIX_FALLBACKS: Array<[string, string]> = [
  ['claude-opus-4-7',  'claude-opus-4-7'],
  ['claude-opus-4-6',  'claude-opus-4-6'],
  ['claude-opus',      'claude-opus-4-7'],
  ['claude-sonnet-4',  'claude-sonnet-4-6'],
  ['claude-sonnet',    'claude-sonnet-4-6'],
  ['claude-haiku-4',   'claude-haiku-4-5'],
  ['claude-haiku',     'claude-haiku-4-5'],
  ['gpt-5.5',          'gpt-5.5'],
  ['gpt-5-mini',       'gpt-5-mini'],
  ['gpt-5',            'gpt-5'],
  ['gpt-4o-mini',      'gpt-4o-mini'],
  ['gpt-4o',           'gpt-4o'],
  ['gpt-4-turbo',      'gpt-4-turbo'],
  ['o1-mini',          'o1-mini'],
  ['o1',               'o1'],
  ['o3-mini',          'o3-mini'],
  ['gemini-2.5-flash', 'gemini-2.5-flash'],
  ['gemini-2.5-pro',   'gemini-2.5-pro'],
  ['gemini-2.0-flash-lite', 'gemini-2.0-flash-lite'],
  ['gemini-2.0-flash', 'gemini-2.0-flash'],
  ['gemini-1.5-pro',   'gemini-1.5-pro'],
  ['gemini-1.5-flash', 'gemini-1.5-flash'],
  ['deepseek-v4-flash','deepseek-v4-flash'],
  ['deepseek-v4-pro',  'deepseek-v4-pro'],
  ['deepseek-reasoner','deepseek-reasoner'],
  ['deepseek-coder',   'deepseek-coder'],
  ['deepseek-chat',    'deepseek-chat'],
  ['glm-5.1',          'glm-5.1'],
  ['glm-4.7-flash',    'glm-4.7-flash'],
  ['glm-4.6',          'glm-4.6'],
  ['glm-4.5-flash',    'glm-4.5-flash'],
  ['glm-4.5-airx',     'glm-4.5-airx'],
  ['glm-4.5-air',      'glm-4.5-air'],
  ['glm-4.5-x',        'glm-4.5-x'],
  ['glm-4.5',          'glm-4.5'],
  ['kimi-k2-thinking-turbo', 'kimi-k2-thinking-turbo'],
  ['kimi-k2-thinking', 'kimi-k2-thinking'],
  ['kimi-k2-turbo-preview', 'kimi-k2-turbo-preview'],
  ['kimi-k2.6',        'kimi-k2.6'],
  ['kimi-k2.5',        'kimi-k2.5'],
];

const warnedMissing = new Set<string>();

export function getPricing(model: string | null | undefined): ModelPricing | null {
  if (!model) return null;
  const direct = MODEL_PRICING[model];
  if (direct) return direct;
  for (const [prefix, alias] of PREFIX_FALLBACKS) {
    if (model.startsWith(prefix)) {
      const aliased = MODEL_PRICING[alias];
      if (aliased) return aliased;
    }
  }
  if (!warnedMissing.has(model)) {
    warnedMissing.add(model);
    // Single-line stderr — the user's dashboard surfaces "estimated cost: 0"
    // which makes the gap visible without flooding logs.
    console.warn(`[pricing] no entry for model "${model}" — cost will report 0`);
  }
  return null;
}

export interface UsageForCost {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/**
 * Estimate USD cost for a single turn. cache_read tokens are subtracted
 * from full input tokens (providers report them as a subset of input)
 * before pricing — re-pricing the cached fraction at the cheaper rate.
 *
 * Returns 0 (not null) when the model is unknown so callers don't have
 * to special-case it; the warning in getPricing() makes the gap visible.
 */
export function estimateCost(
  _provider: string | null | undefined,
  model: string | null | undefined,
  usage: UsageForCost | null | undefined,
): number {
  if (!usage) return 0;
  const pricing = getPricing(model);
  if (!pricing) return 0;

  const inputTotal = usage.input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;

  // Anthropic semantics: input_tokens excludes cache_read and cache_creation.
  // OpenAI semantics: input_tokens INCLUDES cached_tokens.
  // We handle both by clamping inputBilled to non-negative.
  const inputBilled = Math.max(0, inputTotal - cacheRead - cacheWrite);

  const inputCost = (inputBilled * pricing.input) / 1_000_000;
  const outputCost = (output * pricing.output) / 1_000_000;
  const cacheReadCost = (cacheRead * (pricing.cacheRead ?? pricing.input)) / 1_000_000;
  const cacheWriteCost = (cacheWrite * (pricing.cacheWrite ?? pricing.input)) / 1_000_000;

  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}
