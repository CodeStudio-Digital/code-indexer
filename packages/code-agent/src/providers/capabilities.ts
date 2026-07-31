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
 *      (carries context_window, max_tools and default_max_tokens per model)
 *   3. MODEL_REGISTRY static file (model-registry.ts)
 *   4. Prefix fallbacks (context window + max tools) for variants that ship
 *      faster than the static registry is updated.
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
// Carries the admin-tunable per-model values: context_window and max_tools.
// NOTE: module-global — worker_threads get their own copy, so every worker
// boot (coder-worker / company-worker) must call mergeDBCapabilities itself.
let dbLayer: Record<string, {
  contextWindow?: number;
  maxTools?: number;
  maxOutputTokens?: number;
}> = {};

/**
 * Load context-window / max-tools / max-output values from provider_models
 * into the in-memory lookup. Call this after the DB is ready and after any
 * model refresh so getModelContextWindow() / getModelMaxTools() return
 * up-to-date values.
 */
export function mergeDBCapabilities(
  models: ReadonlyArray<{
    model_id: string;
    context_window: number | null;
    max_tools?: number | null;
    default_max_tokens?: number | null;
  }>
): void {
  const next: typeof dbLayer = {};
  for (const m of models) {
    if (m.context_window == null && m.max_tools == null && m.default_max_tokens == null) continue;
    next[m.model_id] = {
      ...(m.context_window != null ? { contextWindow: m.context_window } : {}),
      ...(m.max_tools != null ? { maxTools: m.max_tools } : {}),
      ...(m.default_max_tokens != null ? { maxOutputTokens: m.default_max_tokens } : {}),
    };
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

/**
 * Some integration layers qualify a model with its provider (`zai.glm-5`).
 * Capability storage and family rules use the wire model id (`glm-5`). Keep
 * the exact key first so an explicit qualified override still wins, then try
 * the safely de-qualified alias for known provider namespaces only.
 */
const CAPABILITY_PROVIDER_QUALIFIERS = new Set([
  'anthropic',
  'azure',
  'bedrock',
  'chatgpt',
  'copilot',
  'deepseek',
  'fugu',
  'gemini',
  'google',
  'kimi',
  'kimi-code',
  'mistral',
  'moonshot',
  'openai',
  'openrouter',
  'zai',
]);

const QUALIFIED_GLM_MODEL = /(?:^|[./])((?:glm-(?:4|5)|glm[45])[^/]*)$/i;

function capabilityModelKeys(model: string): string[] {
  const exact = model.trim();
  if (!exact) return [''];
  const keys = [exact];
  const dot = exact.indexOf('.');
  if (dot > 0 && dot < exact.length - 1) {
    const qualifier = exact.slice(0, dot).toLowerCase();
    if (CAPABILITY_PROVIDER_QUALIFIERS.has(qualifier)) {
      keys.push(exact.slice(dot + 1));
    }
  }
  // Hosted catalogs also namespace GLM ids with paths, for example
  // `z-ai/glm-5` (OpenRouter) and `@cf/zai-org/glm-5.2` (Cloudflare).
  // The family alias is lookup-only; the original wire id remains untouched.
  const glmAlias = exact.match(QUALIFIED_GLM_MODEL)?.[1];
  if (glmAlias && !keys.includes(glmAlias)) keys.push(glmAlias);
  return keys;
}

function findCapabilityValue<K extends keyof ModelCapability>(
  layer: Readonly<Record<string, Partial<ModelCapability> | undefined>>,
  model: string,
  field: K,
): ModelCapability[K] | undefined {
  for (const key of capabilityModelKeys(model)) {
    const value = layer[key]?.[field];
    if (value != null) return value as ModelCapability[K];
  }
  return undefined;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Max-tools prefix fallbacks for model variants that ship before the static
 * registry is updated. The original GLM bug was exactly this: new glm-*
 * variants silently inherited the 200 default and the cap never fired.
 * Most-specific prefix first (same convention as
 * CONTEXT_WINDOW_PREFIX_FALLBACKS below).
 */
const MAX_TOOLS_PREFIX_FALLBACKS: Array<[string, number]> = [
  ['glm-5',         96],
  ['glm-4.7-flash', 32],
  ['glm-4.6',       48],
  ['glm-4.5-air',   32],
  ['glm-4.5-x',     32],
  ['glm-4.5-flash', 32],
  ['glm-4.5',       48],
  ['glm-4',         48],
];

/**
 * Look up the max-tools cap for a model.
 * Priority: env var > DB (admin-set) > static registry > prefix fallback > 200.
 */
export function getModelMaxTools(model: string): number {
  const override = loadOverride();
  const overrideValue = findCapabilityValue(override, model, 'maxTools');
  if (overrideValue != null) return overrideValue;
  const dbValue = findCapabilityValue(dbLayer, model, 'maxTools');
  if (dbValue != null) return dbValue;
  const reg = findCapabilityValue(MODEL_REGISTRY, model, 'maxTools');
  if (reg != null) return reg;
  for (const key of capabilityModelKeys(model)) {
    for (const [prefix, cap] of MAX_TOOLS_PREFIX_FALLBACKS) {
      if (key.startsWith(prefix)) return cap;
    }
  }
  return 200;
}

/**
 * Look up the context window size for a model.
 * Priority: env var > DB > static registry > prefix fallback.
 * Returns null when unknown.
 */
export function getModelContextWindow(model: string): number | null {
  const override = loadOverride();
  const overrideValue = findCapabilityValue(override, model, 'contextWindow');
  if (overrideValue != null) return overrideValue;
  const dbValue = findCapabilityValue(dbLayer, model, 'contextWindow');
  if (dbValue != null) return dbValue;
  return getRegistryContextWindow(model);
}

/**
 * Look up the max output tokens for a model. The persisted per-model value
 * wins over the static registry so the request payload and context reservation
 * use the same admin-selected limit. Falls back to FALLBACK when unknown.
 */
export function getMaxOutputTokens(model: string): number {
  const override = loadOverride();
  const overrideValue = findCapabilityValue(override, model, 'maxOutputTokens');
  if (overrideValue != null) return overrideValue;
  const dbValue = findCapabilityValue(dbLayer, model, 'maxOutputTokens');
  if (dbValue != null) return dbValue;
  const reg = findCapabilityValue(MODEL_REGISTRY, model, 'maxOutputTokens');
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
  return findCapabilityValue(override, model, 'note') ??
    findCapabilityValue(MODEL_REGISTRY, model, 'note');
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
  // Sakana AI's official Codex catalog declares a 1M context window for every
  // Fugu, Fugu Ultra and Fugu Cyber model. The >272K boundary is a price tier,
  // not the model's context limit.
  ['fugu',                 1_000_000],
];

/**
 * Look up context-window from the static registry first, then walk the
 * prefix table. Used by live discovery to seed DB rows for providers whose
 * APIs don't expose context-window (notably Z.AI's `/v4/models`, which
 * returns IDs but no context_length field).
 */
/**
 * `[1m]` is the conventional model-id suffix for a 1M-context variant —
 * Z.AI's `glm-5.2[1m]` (https://docs.z.ai/devpack/latest-model) and
 * Anthropic's 1M beta both use it. Detect it so the budget reflects the real
 * window instead of the base-family prefix (e.g. `glm-5` → 200K). Checked
 * before the prefix table so the suffix always wins; an exact MODEL_REGISTRY
 * entry still takes precedence over it.
 */
const ONE_MILLION_CONTEXT_WINDOW = 1_000_000;
function oneMillionSuffixWindow(model: string): number | null {
  return model.includes('[1m]') ? ONE_MILLION_CONTEXT_WINDOW : null;
}

export function getRegistryContextWindow(model: string): number | null {
  if (!model) return null;
  const direct = findCapabilityValue(MODEL_REGISTRY, model, 'contextWindow');
  if (direct != null) return direct;
  for (const key of capabilityModelKeys(model)) {
    const oneM = oneMillionSuffixWindow(key);
    if (oneM != null) return oneM;
    for (const [prefix, cw] of CONTEXT_WINDOW_PREFIX_FALLBACKS) {
      if (key.startsWith(prefix)) return cw;
    }
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
  for (const key of capabilityModelKeys(model)) {
    const direct = MODEL_REGISTRY[key]?.contextWindow;
    if (direct != null) {
      return { window: direct, source: 'registry-exact', via: `registry:${key}` };
    }
  }
  for (const key of capabilityModelKeys(model)) {
    const oneM = oneMillionSuffixWindow(key);
    if (oneM != null) {
      return { window: oneM, source: 'registry-prefix', via: 'suffix:[1m]' };
    }
    for (const [prefix, cw] of CONTEXT_WINDOW_PREFIX_FALLBACKS) {
      if (key.startsWith(prefix)) {
        return { window: cw, source: 'registry-prefix', via: `prefix:${prefix}` };
      }
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
  const keys = capabilityModelKeys(model);
  const m = keys[keys.length - 1]!.toLowerCase();

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

/**
 * Best-effort image-input (vision) capability for a model:
 *   - `true`      → sees images natively → send raw image blocks.
 *   - `false`     → text-only → images must be described (vision fallback).
 *   - `undefined` → unknown → the runner does NOT auto-describe (no surprise
 *                   downgrade); the user can still force it via the flag.
 *
 * Priority: explicit provider `input_modalities` (reliable when the provider
 * API reports it), then model-family heuristics. `supports_attachments` is
 * intentionally NOT consulted — it covers document/PDF uploads and is `true`
 * for text-only models like GLM, which made the vision fallback silently skip
 * and a blind model hallucinate about a screenshot it never actually saw.
 */
export function modelSupportsVision(opts: {
  providerKind?: string | null;
  modelId: string;
  inputModalities?: string[] | null;
}): boolean | undefined {
  if (opts.inputModalities && opts.inputModalities.length > 0) {
    return opts.inputModalities.includes('image');
  }
  const kind = (opts.providerKind ?? '').toLowerCase();
  const modelKeys = capabilityModelKeys(opts.modelId ?? '');
  const m = modelKeys[modelKeys.length - 1]!.toLowerCase();

  // Known TEXT-ONLY families (no image input).
  if (kind === 'zai' || m.startsWith('glm')) return false;
  if (kind === 'deepseek' || m.startsWith('deepseek')) return false;

  // Known VISION families (multimodal across their current line-ups).
  if (kind === 'anthropic' || kind === 'bedrock' || m.includes('claude')) return true;
  if (kind === 'gemini' || m.includes('gemini')) return true;
  if (kind === 'openai' || kind === 'azure' || kind === 'chatgpt') {
    if (/gpt-5|gpt-4o|gpt-4\.1|gpt-4-turbo|chatgpt-4o|o1|o3|o4/.test(m)) return true;
    if (/gpt-4-0|gpt-4-32k|gpt-3\.5|text-|davinci/.test(m)) return false;
  }
  // Kimi (kimi-vl sees, k2 doesn't), Mistral, etc. → unknown.
  return undefined;
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
