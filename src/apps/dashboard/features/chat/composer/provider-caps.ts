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
    // zai's `glm-5` family supports thinking but earlier GLM models do not —
    // keep the same model-aware narrowing the previous hard-coded list used.
    if (option.kind === 'zai') {
      return /^glm-5(\.|-)/.test((model ?? '').split('::')[0]);
    }
    return true;
  }
  // Fallback for the legacy provider list (no capabilities field) — keeps
  // chatgpt-kind providers working even when the API hasn't been re-rolled.
  return option.kind === 'chatgpt';
}
