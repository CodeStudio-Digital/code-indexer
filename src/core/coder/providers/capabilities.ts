/**
 * Per-model tool capability hints.
 *
 * Different provider/model combinations handle large tool catalogs very
 * differently. GLM-flash and smaller DeepSeek variants start confusing tool
 * names above ~30 tools; Opus/Sonnet 4 handle 200+ without breaking a sweat.
 * This module encodes those limits so the runner can cap the tool array at
 * the number the model can actually reason over, instead of shipping the
 * full catalog and hoping.
 *
 * The cap is a HINT, not a hard ceiling. It's applied AFTER tier filtering:
 *   final_tools = head(filterByTiers(all_tools), cap_for_model)
 * When the cap trims the list, the lowest-priority tools go first. Priority
 * is determined by tier (bootstrap > navigate > admin) then by the order
 * they appear in the registry — so the critical discovery tools always
 * survive the cut.
 *
 * Runtime priority (highest → lowest):
 *   1. CODER_MODEL_CAPS env var  (JSON: {"model-id": {"maxTools": N, "contextWindow": N}})
 *   2. DB layer loaded via mergeDBCapabilities() on server startup
 *   3. MODEL_REGISTRY static file (model-registry.ts)
 */

import { MODEL_REGISTRY } from './model-registry.js';

export interface ModelCapability {
  /** Hard cap on the number of tools in the tools array. */
  maxTools: number;
  /** Context window size in tokens. Used by the dashboard to show usage vs capacity. */
  contextWindow?: number;
  /** Maximum tokens the model can emit in a single response. */
  maxOutputTokens?: number;
  /** Short human-readable note shown in logs. */
  note?: string;
}

/**
 * Conservative fallback when an unknown model has neither registry entry nor
 * prefix match. Picked to be small enough that compaction triggers before we
 * blow up an unknown provider, but large enough to be useful (~1/3 the way
 * between common 128K and 200K windows).
 */
const FALLBACK_CONTEXT_WINDOW = 128_000;
/** Default per-response output cap when the registry doesn't say. */
const FALLBACK_MAX_OUTPUT_TOKENS = 8_192;
/** Hard cap on the output reservation: never reserve more than this for a single
 * response, even on models that nominally support 100K+ output (o1/o3). The
 * point is to keep enough headroom to summarize, not to let the model
 * monopolize the window. Matches Claude Code's MAX_OUTPUT_TOKENS_FOR_SUMMARY. */
const MAX_RESERVED_OUTPUT = 20_000;

// ── DB layer ─────────────────────────────────────────────────────────────────
// Populated once on server startup by mergeDBCapabilities(). Keyed by model_id.
// Only contextWindow is stored here — maxTools lives only in the registry.
let dbLayer: Record<string, number> = {};

/**
 * Load context-window values from the provider_models DB rows into the
 * in-memory lookup. Call this after the DB is ready and after any model
 * refresh so getModelContextWindow() returns up-to-date values.
 */
export function mergeDBCapabilities(
  models: ReadonlyArray<{ model_id: string; context_window: number | null }>
): void {
  const next: Record<string, number> = {};
  for (const m of models) {
    if (m.context_window != null) {
      next[m.model_id] = m.context_window;
    }
  }
  dbLayer = next;
}

// ── Env override ─────────────────────────────────────────────────────────────
let cachedOverride: Record<string, ModelCapability> | null = null;

function loadOverride(): Record<string, ModelCapability> {
  if (cachedOverride) return cachedOverride;
  const raw = process.env.CODER_MODEL_CAPS;
  if (!raw) return (cachedOverride = {});
  try {
    cachedOverride = JSON.parse(raw) as Record<string, ModelCapability>;
  } catch (e) {
    console.warn(`[coder] invalid CODER_MODEL_CAPS JSON: ${e instanceof Error ? e.message : String(e)}`);
    cachedOverride = {};
  }
  return cachedOverride;
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Look up the max-tools cap for a model. Falls back to 200 when unknown. */
export function getModelMaxTools(model: string): number {
  const override = loadOverride();
  const cap = override[model] ?? MODEL_REGISTRY[model];
  return cap?.maxTools ?? 200;
}

/**
 * Look up the context window size for a model.
 * Priority: env var > DB > static registry > prefix fallback.
 * Returns null when unknown.
 */
export function getModelContextWindow(model: string): number | null {
  const override = loadOverride();
  if (override[model]?.contextWindow != null) return override[model].contextWindow!;
  if (dbLayer[model] != null) return dbLayer[model];
  return getRegistryContextWindow(model);
}

/**
 * Look up the max output tokens for a model. Falls back to FALLBACK when
 * unknown. Used by `getEffectiveContextWindow` to reserve output headroom.
 */
export function getMaxOutputTokens(model: string): number {
  const override = loadOverride();
  if (override[model]?.maxOutputTokens != null) return override[model].maxOutputTokens!;
  const reg = MODEL_REGISTRY[model]?.maxOutputTokens;
  if (reg != null) return reg;
  return FALLBACK_MAX_OUTPUT_TOKENS;
}

export interface EffectiveContextWindow {
  /** Raw context window from registry/DB/env. */
  window: number;
  /** Output reservation, clamped to MAX_RESERVED_OUTPUT. */
  reservedOutput: number;
  /** window − reservedOutput. The number compaction triggers measure against. */
  effective: number;
  /** True when we hit the conservative fallback (no registry entry or prefix match). */
  isFallback: boolean;
}

/**
 * Compute the model's effective context window with output reservation.
 *
 *   effective = window − min(maxOutputTokens, MAX_RESERVED_OUTPUT)
 *
 * The compaction trigger then operates on `effective`, not `window`, so the
 * model always has headroom to actually emit a response after we've packed
 * the prompt. Claude Code calls this "MAX_OUTPUT_TOKENS_FOR_SUMMARY"; we
 * use the same idea but expose the components for telemetry.
 */
export function getEffectiveContextWindow(model: string): EffectiveContextWindow {
  let window = getModelContextWindow(model);
  let isFallback = false;
  if (window == null) {
    console.warn(`[coder] no context window known for "${model}", using ${FALLBACK_CONTEXT_WINDOW} fallback`);
    window = FALLBACK_CONTEXT_WINDOW;
    isFallback = true;
  }
  const reservedOutput = Math.min(getMaxOutputTokens(model), MAX_RESERVED_OUTPUT);
  return {
    window,
    reservedOutput,
    effective: Math.max(1, window - reservedOutput),
    isFallback,
  };
}

export function getModelCapabilityNote(model: string): string | undefined {
  const override = loadOverride();
  return (override[model] ?? MODEL_REGISTRY[model])?.note;
}

/**
 * Prefix-based context-window fallback. Used when discovery returns a model
 * id we don't have an exact entry for (Z.AI publishes glm-4.x variants
 * faster than we update model-registry.ts; OpenAI ships dated GPT variants
 * like `gpt-5-2026-04-15`). Order matters — most specific prefix first so
 * a `glm-4.7-flash` doesn't accidentally inherit `glm-4` defaults.
 *
 * Sourced from each provider's official docs at the time of writing. When
 * uncertain we choose the smaller window (defensive — overestimating breaks
 * compaction triggers).
 */
const CONTEXT_WINDOW_PREFIX_FALLBACKS: Array<[string, number]> = [
  // Anthropic
  ['claude-opus-4',          200_000],
  ['claude-sonnet-4',        200_000],
  ['claude-haiku-4',         200_000],
  ['claude-opus',            200_000],
  ['claude-sonnet',          200_000],
  ['claude-haiku',           200_000],
  // OpenAI
  ['gpt-5.5',                272_000],
  ['gpt-5-mini',             272_000],
  ['gpt-5',                  272_000],
  ['gpt-4o-mini',            128_000],
  ['gpt-4o',                 128_000],
  ['gpt-4-turbo',            128_000],
  ['o1-mini',                128_000],
  ['o1',                     200_000],
  ['o3-mini',                200_000],
  // Z.AI / GLM — verified at docs.z.ai
  ['glm-5',                  200_000],
  ['glm-4.7',                128_000],
  ['glm-4.6',                200_000],
  ['glm-4.5',                128_000],
  ['glm-4-32b',              128_000],
  ['glm-4-air',              128_000],
  ['glm-4',                  128_000],
  // DeepSeek V4
  ['deepseek-v4',          1_000_000],
  ['deepseek',             1_000_000],
  // Kimi
  ['kimi-k2',                262_144],
  // Gemini
  ['gemini-2.5-flash',     1_048_576],
  ['gemini-2.5-pro',       1_048_576],
  ['gemini-2.0-flash',     1_048_576],
  ['gemini-1.5-pro',       2_097_152],
  ['gemini-1.5-flash',     1_048_576],
  ['gemini',               1_048_576],
];

/**
 * Look up context-window from the static registry first, then walk the
 * prefix table. Used by live discovery to seed DB rows for providers whose
 * APIs don't expose context-window (notably Z.AI's `/v4/models`, which
 * returns IDs but no context_length field).
 */
export function getRegistryContextWindow(model: string): number | null {
  if (!model) return null;
  const direct = MODEL_REGISTRY[model]?.contextWindow;
  if (direct != null) return direct;
  for (const [prefix, cw] of CONTEXT_WINDOW_PREFIX_FALLBACKS) {
    if (model.startsWith(prefix)) return cw;
  }
  return null;
}
