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
  /** Short human-readable note shown in logs. */
  note?: string;
}

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
 * Priority: env var > DB > static registry.
 * Returns null when unknown.
 */
export function getModelContextWindow(model: string): number | null {
  const override = loadOverride();
  if (override[model]?.contextWindow != null) return override[model].contextWindow!;
  if (dbLayer[model] != null) return dbLayer[model];
  return MODEL_REGISTRY[model]?.contextWindow ?? null;
}

export function getModelCapabilityNote(model: string): string | undefined {
  const override = loadOverride();
  return (override[model] ?? MODEL_REGISTRY[model])?.note;
}

/**
 * Look up context-window from the static registry only (no DB, no env).
 * Used by live discovery to seed DB rows for providers whose APIs don't
 * expose context-window.
 */
export function getRegistryContextWindow(model: string): number | null {
  return MODEL_REGISTRY[model]?.contextWindow ?? null;
}
