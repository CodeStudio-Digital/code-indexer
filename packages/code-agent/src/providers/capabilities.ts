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

import { MODEL_REGISTRY } from '@mcp/code-agent/providers/model-registry.js';

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
  /**
   * True when we did NOT find an exact value via env/db/registry/prefix.
   * Phase E expands this to mean "inferred or hardcoded fallback"; the
   * specific path is in `source`.
   */
  isFallback: boolean;
  /**
   * Phase E — resolution path. `registry` means env/db/exact/prefix found
   * a value (high confidence). `inferred` means the family heuristic
   * filled in based on model-name pattern (medium confidence). `fallback`
   * means we used the hardcoded 128K (no confidence — model unrecognized).
   */
  source?: 'registry' | 'inferred' | 'fallback';
  /** Human-readable detail of which rule fired (e.g., 'family:anthropic-opus'). */
  via?: string;
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
  let source: 'registry' | 'inferred' | 'fallback' = 'registry';
  let via: string | undefined;
  if (window == null) {
    // Phase E — try the family heuristic before falling to hardcoded 128K.
    const inferred = inferContextWindow(model);
    if (inferred) {
      window = inferred.window;
      isFallback = true;
      source = 'inferred';
      via = inferred.via;
      recordCapabilityFallback({ model, source: 'inferred', via: inferred.via, window });
      console.warn(
        `[coder] inferred context window for "${model}" → ${window} via ${inferred.via} (no registry entry; admin can override in /admin/providers)`,
      );
    } else {
      window = FALLBACK_CONTEXT_WINDOW;
      isFallback = true;
      source = 'fallback';
      via = 'hardcoded:128k';
      recordCapabilityFallback({ model, source: 'fallback', via, window });
      console.warn(
        `[coder] no context window known for "${model}", no family-heuristic match — using hardcoded ${FALLBACK_CONTEXT_WINDOW}`,
      );
    }
  }
  const reservedOutput = Math.min(getMaxOutputTokens(model), MAX_RESERVED_OUTPUT);
  return {
    window,
    reservedOutput,
    effective: Math.max(1, window - reservedOutput),
    isFallback,
    source,
    via,
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

// ── Phase F — resolution-with-source for admin backfill tooling ──────────────

export interface ResolvedContextWindow {
  window: number;
  /**
   * Where the value came from. `fallback` means we hit the hardcoded
   * 128K because nothing else matched — admin tooling should treat this
   * as low-confidence and avoid baking it into the DB.
   */
  source: 'registry-exact' | 'registry-prefix' | 'inferred' | 'fallback';
  /** Stable identifier for the rule that fired (used by UI + telemetry). */
  via: string;
}

/**
 * Full-chain resolver that reports HOW the window was resolved.
 *
 * Unlike `getEffectiveContextWindow` (which is the runtime entry point and
 * folds env/DB layers in), this looks only at registry + prefix + inferred.
 * It's the function admin backfill code should use to decide whether to
 * write a value to the DB: high-confidence sources (exact/prefix/inferred)
 * are safe to backfill; `fallback` should be left as NULL so the runtime
 * fallback warning continues to surface the issue.
 */
export function resolveContextWindowWithSource(model: string): ResolvedContextWindow {
  if (!model) {
    return { window: FALLBACK_CONTEXT_WINDOW, source: 'fallback', via: 'hardcoded:empty-model-id' };
  }
  const direct = MODEL_REGISTRY[model]?.contextWindow;
  if (direct != null) {
    return { window: direct, source: 'registry-exact', via: `registry:${model}` };
  }
  for (const [prefix, cw] of CONTEXT_WINDOW_PREFIX_FALLBACKS) {
    if (model.startsWith(prefix)) {
      return { window: cw, source: 'registry-prefix', via: `prefix:${prefix}` };
    }
  }
  const inferred = inferContextWindow(model);
  if (inferred) {
    return { window: inferred.window, source: 'inferred', via: inferred.via };
  }
  return { window: FALLBACK_CONTEXT_WINDOW, source: 'fallback', via: 'hardcoded:128k' };
}

// ── Phase E — heuristic family inference ─────────────────────────────────────
//
// When the prefix table misses (a custom provider routes through a
// vendor-qualified name, the user names a model differently, or a new
// variant ships before the static table is updated), we still want a
// SENSIBLE context-window number rather than the conservative 128K
// hardcoded fallback. The heuristic detects provider family by
// case-insensitive name pattern and picks the most common window for
// that family.
//
// Conservative on purpose: when in doubt between two windows, pick the
// SMALLER one. Compaction firing slightly early is harmless; never
// firing because we over-estimated is what burned session 763.

export interface InferredContextWindow {
  window: number;
  /** Stable identifier for the rule that fired — used by telemetry. */
  via: string;
}

/**
 * Pure family-heuristic resolver. Returns null when no family pattern
 * matches; caller falls through to the hardcoded 128K fallback.
 *
 * Exported for unit-testing and so admin tools can preview what an
 * unknown model would resolve to before the admin commits it manually.
 */
export function inferContextWindow(model: string): InferredContextWindow | null {
  if (!model) return null;
  const m = model.toLowerCase();

  // Anthropic family — Claude 4.x and Opus/Sonnet/Haiku variants all 200K.
  if (m.includes('claude') || m.startsWith('anthropic')) {
    if (m.includes('opus')) return { window: 200_000, via: 'family:anthropic-opus' };
    if (m.includes('sonnet')) return { window: 200_000, via: 'family:anthropic-sonnet' };
    if (m.includes('haiku')) return { window: 200_000, via: 'family:anthropic-haiku' };
    return { window: 200_000, via: 'family:anthropic-generic' };
  }

  // Google Gemini family — 1.5-pro has the largest window, others 1M.
  if (m.includes('gemini')) {
    if (m.includes('1.5') && m.includes('pro')) return { window: 2_097_152, via: 'family:gemini-1.5-pro' };
    if (m.includes('flash')) return { window: 1_048_576, via: 'family:gemini-flash' };
    if (m.includes('pro')) return { window: 1_048_576, via: 'family:gemini-pro' };
    return { window: 1_048_576, via: 'family:gemini-generic' };
  }

  // OpenAI family — GPT-5 line is 272K, GPT-4 line 128K, reasoning 200K.
  if (m.startsWith('gpt-') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('chatgpt')) {
    if (m.includes('gpt-5')) return { window: 272_000, via: 'family:openai-gpt5' };
    if (m.startsWith('o1-mini') || m.startsWith('o3-mini')) {
      return { window: 128_000, via: 'family:openai-reasoning-mini' };
    }
    if (m.startsWith('o1') || m.startsWith('o3')) {
      return { window: 200_000, via: 'family:openai-reasoning' };
    }
    if (m.includes('gpt-4')) return { window: 128_000, via: 'family:openai-gpt4' };
    return { window: 128_000, via: 'family:openai-generic' };
  }

  // Z.AI / GLM family — most variants 128K, GLM-5 line 200K.
  if (m.startsWith('glm-') || m.startsWith('glm4') || m.startsWith('glm5')) {
    if (m.includes('5') || m.startsWith('glm5')) return { window: 200_000, via: 'family:zai-glm5' };
    if (m.includes('4.6')) return { window: 200_000, via: 'family:zai-glm46' };
    return { window: 128_000, via: 'family:zai-generic' };
  }

  // DeepSeek — V4 line is 1M, older 128K.
  if (m.startsWith('deepseek')) {
    if (m.includes('v4') || m.includes('-4')) return { window: 1_000_000, via: 'family:deepseek-v4' };
    return { window: 128_000, via: 'family:deepseek-generic' };
  }

  // Kimi / Moonshot — K2 line is 262K.
  if (m.startsWith('kimi') || m.startsWith('moonshot')) {
    return { window: 200_000, via: 'family:moonshot-generic' };
  }

  // Mistral / Mixtral — historical default.
  if (m.startsWith('mistral') || m.includes('mixtral')) {
    return { window: 32_000, via: 'family:mistral-generic' };
  }

  // Llama / Meta — historical default for instruct variants.
  if (m.startsWith('llama') || m.startsWith('meta-llama')) {
    return { window: 128_000, via: 'family:meta-llama-generic' };
  }

  return null;
}

// ── Phase E — fallback usage tracker ─────────────────────────────────────────
//
// In-memory record of every model that resolved via heuristic OR hardcoded
// fallback. Admins can query this through an admin route (Phase G) to see
// "which models are running with imprecise capabilities and need a manual
// context_window set". Ring-buffer capped at FALLBACK_TRACKER_MAX to avoid
// growing unbounded on misconfigured deployments.

export interface CapabilityFallbackEvent {
  model: string;
  source: 'inferred' | 'fallback';
  via: string;
  window: number;
  /** ms since epoch — first time we saw this model fall back. */
  firstSeenAt: number;
  /** Most recent time we saw this model fall back. */
  lastSeenAt: number;
  /** How many times we've resolved this model via fallback path. */
  count: number;
}

const FALLBACK_TRACKER_MAX = 100;
const fallbackTracker = new Map<string, CapabilityFallbackEvent>();

/**
 * Internal — record a fallback resolution. Exported only for tests.
 * The caller MUST pass the `source` ('inferred' or 'fallback'); pure
 * registry hits do NOT call this.
 */
export function recordCapabilityFallback(args: {
  model: string;
  source: 'inferred' | 'fallback';
  via: string;
  window: number;
}): void {
  const now = Date.now();
  const existing = fallbackTracker.get(args.model);
  if (existing) {
    existing.count++;
    existing.lastSeenAt = now;
    // Update the via if the resolution changed (heuristic table update
    // could shift the same model from one rule to another).
    existing.via = args.via;
    existing.window = args.window;
    existing.source = args.source;
    return;
  }
  if (fallbackTracker.size >= FALLBACK_TRACKER_MAX) {
    // Evict the oldest (insertion-order) entry. Map iteration order is
    // insertion order in JS, so the first key is the oldest.
    const oldestKey = fallbackTracker.keys().next().value;
    if (oldestKey) fallbackTracker.delete(oldestKey);
  }
  fallbackTracker.set(args.model, {
    model: args.model,
    source: args.source,
    via: args.via,
    window: args.window,
    firstSeenAt: now,
    lastSeenAt: now,
    count: 1,
  });
}

/**
 * Read the recent-fallbacks list. Returns a snapshot, sorted by most
 * recent first. Used by the admin telemetry route and by tests.
 */
export function getRecentCapabilityFallbacks(): CapabilityFallbackEvent[] {
  return [...fallbackTracker.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

/** Test-only — reset the in-memory tracker between cases. */
export function clearCapabilityFallbacksForTest(): void {
  fallbackTracker.clear();
}
