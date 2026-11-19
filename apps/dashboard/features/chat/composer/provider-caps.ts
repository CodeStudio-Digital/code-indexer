import type { ProviderOption } from '../types.js';
import { selectedProviderModel } from '../execution-mode-state.js';
import { getZaiModelReasoning } from '@mcp/shared/providers/zai-models.js';

/**
 * Resolve whether a provider supports extended thinking. The capability flag
 * comes from the static provider definition (see `core/providers/registry.ts`)
 * and is forwarded to the dashboard via `/api/coder/providers`. The previous
 * implementation hard-coded a list of provider ids; this helper lets the UI
 * pick up new providers automatically when their definition declares the flag.
 */
export function providerSupportsThinking(
  providerId: string | null | undefined,
  providerOptions: ProviderOption[],
  model?: string | null,
): boolean {
  if (!providerId) return false;
  const option = providerOptions.find((p) => p.id === providerId);
  if (!option) return false;
  if (option.capabilities?.supportsThinking === true) {
    // Copilot exposes reasoning capability and reasoning control separately.
    // Fixed/adaptive models such as Gemini 3.5 can reason, but the public
    // Copilot surface does not offer a manual deep-thinking level for them.
    // Only show the toggle when the selected catalog row has real levels.
    if (option.kind === 'copilot') {
      return resolveReasoningLevels(providerId, providerOptions, model).length > 0;
    }
    if (option.kind === 'zai') {
      const selected = model ?? '';
      // GLM-5.3's reasoning is controlled by the effort selector.
      if (getZaiModelReasoning(selected)) return false;
      const [bare = ''] = selected.split('::');
      return /^glm-(?:5(?:[.\-]|$)|4\.[567])/.test(bare);
    }
    return true;
  }
  // Fallback for the legacy provider list (no capabilities field) — keeps
  // chatgpt-kind providers working even when the API hasn't been re-rolled.
  return option.kind === 'chatgpt';
}

/**
 * Resolve the discrete reasoning-effort levels the selected model accepts
 * (from `provider_models.supported_reasoning_levels`, forwarded via
 * `/api/coder/providers`). Returns `[]` when the model has none — the composer
 * uses a non-empty result to decide whether to render the effort selector.
 * `model` may carry a `::mode` suffix (the composer encodes it that way).
 */
export function resolveReasoningLevels(
  providerId: string | null | undefined,
  providerOptions: ProviderOption[],
  model?: string | null,
): string[] {
  const match = selectedProviderModel(providerId, providerOptions, model);
  // `ultra` is a product execution profile, never a provider-native effort.
  // Filter defensively so stale persisted catalogs cannot put it back into the
  // wire-effort selector before the next model refresh/migration.
  const seen = new Set<string>();
  return (match?.supported_reasoning_levels ?? []).flatMap((raw) => {
    const level = raw.trim();
    const key = level.toLowerCase();
    if (!level || key === 'ultra' || seen.has(key)) return [];
    seen.add(key);
    return [level];
  });
}
