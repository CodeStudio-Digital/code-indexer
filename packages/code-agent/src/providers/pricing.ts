/**
 * Per-model pricing DATA + pure cost math for telemetry.
 *
 * Prices are USD per 1,000,000 tokens. Cache-read reflects the provider's
 * discounted rate on a cache hit (Anthropic ~10%, OpenAI ~50%, Gemini
 * varies). Cache-write reflects Anthropic's one-time premium to populate the
 * cache. Providers without a cache column omit it (treated as full input).
 *
 * This module is PURE: it knows nothing about the DB or the live price
 * cache. Runtime resolution (env override → DB → this static table) and the
 * public estimateCost/getPricing live in ./pricing-cache.ts. Keeping the data
 * here means adding a model is still a one-file nudge next to model-registry.
 *
 * Sources are checked at the time of writing; treat as a snapshot. UI always
 * shows "estimated" so users know it's not a billing source.
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
  // opus-4-8 mirrors opus-4-7 list price. The [1m] row is the 1M-context
  // premium tier (>200K input): ~2x input / ~1.5x output, matching the
  // pattern Anthropic uses for its 1M beta. ESTIMATE — confirm against the
  // published 1M-context price and pin via `manual` if it differs.
  'claude-opus-4-8':            { input: 15.0, output: 75.0,  cacheRead: 1.5,  cacheWrite: 18.75 },
  'claude-opus-4-8[1m]':        { input: 30.0, output: 112.5, cacheRead: 3.0,  cacheWrite: 37.5  },
  'claude-opus-4-7':            { input: 15.0, output: 75.0,  cacheRead: 1.5,  cacheWrite: 18.75 },
  'claude-opus-4-6':            { input: 15.0, output: 75.0,  cacheRead: 1.5,  cacheWrite: 18.75 },
  'claude-sonnet-4-6':          { input: 3.0,  output: 15.0,  cacheRead: 0.3,  cacheWrite: 3.75  },
  'claude-haiku-4-5':           { input: 0.8,  output: 4.0,   cacheRead: 0.08, cacheWrite: 1.0   },

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
  // Most-specific first: opus-4-8 variants before the broad 'claude-opus'.
  ['claude-opus-4-8[1m]', 'claude-opus-4-8[1m]'],
  ['claude-opus-4-8',  'claude-opus-4-8'],
  ['claude-opus-4-7',  'claude-opus-4-7'],
  ['claude-opus-4-6',  'claude-opus-4-6'],
  ['claude-opus',      'claude-opus-4-8'],
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

/**
 * Pure static lookup: exact model id, then prefix fallback. No DB, no
 * logging, no side effects. Returns null when the static table can't price
 * the model — the caller (pricing-cache) decides what to do.
 */
export function lookupStaticPricing(model: string | null | undefined): ModelPricing | null {
  if (!model) return null;
  const direct = MODEL_PRICING[model];
  if (direct) return direct;
  for (const [prefix, alias] of PREFIX_FALLBACKS) {
    if (model.startsWith(prefix)) {
      const aliased = MODEL_PRICING[alias];
      if (aliased) return aliased;
    }
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
 * Pure cost math from already-resolved pricing + usage. cache_read tokens
 * are subtracted from full input tokens (providers report them as a subset)
 * before pricing, then re-priced at the cheaper cache rate.
 *
 * Anthropic semantics: input_tokens EXCLUDES cache_read/cache_creation.
 * OpenAI semantics: input_tokens INCLUDES cached_tokens. Both are handled by
 * clamping inputBilled to non-negative.
 */
export function computeCost(pricing: ModelPricing, usage: UsageForCost): number {
  const inputTotal = usage.input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const inputBilled = Math.max(0, inputTotal - cacheRead - cacheWrite);
  const inputCost = (inputBilled * pricing.input) / 1_000_000;
  const outputCost = (output * pricing.output) / 1_000_000;
  const cacheReadCost = (cacheRead * (pricing.cacheRead ?? pricing.input)) / 1_000_000;
  const cacheWriteCost = (cacheWrite * (pricing.cacheWrite ?? pricing.input)) / 1_000_000;
  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}

/** Plain seed row shape consumed by the store's seedHardcodedModelPrices. */
export interface HardcodedPriceSeed {
  provider: string;
  model_id: string;
  input_per_mtok: number;
  output_per_mtok: number;
  cache_read_per_mtok: number | null;
  cache_write_per_mtok: number | null;
}

/** Flatten MODEL_PRICING into seed rows (provider '' = cross-provider). */
export function hardcodedPriceSeed(): HardcodedPriceSeed[] {
  return Object.entries(MODEL_PRICING).map(([model_id, p]) => ({
    provider: '',
    model_id,
    input_per_mtok: p.input,
    output_per_mtok: p.output,
    cache_read_per_mtok: p.cacheRead ?? null,
    cache_write_per_mtok: p.cacheWrite ?? null,
  }));
}
