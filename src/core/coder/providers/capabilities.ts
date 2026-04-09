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
 * Override the built-in map via env var CODER_MODEL_CAPS (JSON):
 *   CODER_MODEL_CAPS='{"my-custom-model": {"maxTools": 20}}'
 */

export interface ModelCapability {
  /** Hard cap on the number of tools in the tools array. */
  maxTools: number;
  /** Short human-readable note shown in logs. */
  note?: string;
}

const BUILTIN: Record<string, ModelCapability> = {
  // Anthropic — no known issues with large tool lists
  'claude-opus-4-6': { maxTools: 200 },
  'claude-sonnet-4-6': { maxTools: 200 },
  'claude-haiku-4-5-20251001': { maxTools: 120, note: 'Haiku prefers tighter catalogs' },
  // OpenAI
  'gpt-4o': { maxTools: 128 },
  'gpt-4o-mini': { maxTools: 64, note: 'Smaller context = tighter tool catalog' },
  // ZAI / GLM — sensitive to tool-count drift
  'glm-5.1': { maxTools: 50, note: 'GLM-5.1 tool-name confusion rises past ~50 tools' },
  'glm-4.6': { maxTools: 40 },
  // DeepSeek
  'deepseek-chat': { maxTools: 40 },
  'deepseek-coder': { maxTools: 40 },
  // Gemini
  'gemini-2.5-flash': { maxTools: 64 },
  'gemini-2.5-pro': { maxTools: 128 },
};

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

/** Look up the max-tools cap for a model. Falls back to 200 when unknown. */
export function getModelMaxTools(model: string): number {
  const override = loadOverride();
  const cap = override[model] ?? BUILTIN[model];
  return cap?.maxTools ?? 200;
}

export function getModelCapabilityNote(model: string): string | undefined {
  const override = loadOverride();
  return (override[model] ?? BUILTIN[model])?.note;
}
