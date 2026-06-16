import type { ProviderOption } from '../types.js';

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
    // Z.AI's "thinking" parameter is accepted by GLM-4.5+ and the entire
    // GLM-5 family (per docs.z.ai/guides/capabilities/thinking). Older
    // GLM-4.x (4.4, 4.3, 4-air, 4-flash, …) reject it with a 400, so we
    // keep the regex narrow:
    //   - glm-5, glm-5.1, glm-5-turbo, … (5 anything)
    //   - glm-4.5, glm-4.6, glm-4.7 and their variants (.5-air, .6-flash, .7-flashx, …)
    if (option.kind === 'zai') {
      const bare = (model ?? '').split('::')[0];
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
  if (!providerId || !model) return [];
  const option = providerOptions.find((p) => p.id === providerId);
  if (!option) return [];
  const [bare, mode] = model.split('::');
  const match =
    option.models.find(
      (m) => m.id === bare && ((mode ?? '') === '' || (m.mode ?? '') === mode),
    ) ?? option.models.find((m) => m.id === bare);
  return match?.supported_reasoning_levels ?? [];
}
