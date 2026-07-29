/**
 * Fallback chain — automatic provider recovery on persistent errors.
 *
 * Resolution order:
 * 1. Session-level override from the filesystem session state
 * 2. Provider-level chain (provider_configs.fallback_provider_id walk)
 * 3. Global env CODER_FALLBACK_CHAIN (e.g. "anthropic:claude-sonnet-4-6,zai:glm-5.1")
 *
 * The chain is built once at session start and consumed via nextFallback().
 * Each entry is tried at most once; exhausted chains return null.
 */

export interface FallbackEntry {
  provider: string;
  model: string;
}

export interface FallbackChain {
  entries: FallbackEntry[];
  currentIndex: number;
}

/**
 * Build a fallback chain from multiple sources, de-duplicated and ordered.
 *
 * @param sessionFallback  Per-session override (highest priority)
 * @param providerChain    Chain from walking provider_configs.fallback_provider_id
 * @param envChain         CODER_FALLBACK_CHAIN env var (lowest priority)
 */
export function buildFallbackChain(
  sessionFallback: FallbackEntry | null,
  providerChain: FallbackEntry[],
  envChain: string | undefined,
): FallbackChain {
  const seen = new Set<string>();
  const entries: FallbackEntry[] = [];

  const add = (entry: FallbackEntry) => {
    const key = `${entry.provider}:${entry.model}`;
    if (!seen.has(key)) {
      seen.add(key);
      entries.push(entry);
    }
  };

  // 1. Session-level (highest priority)
  if (sessionFallback) add(sessionFallback);

  // 2. Provider-level chain
  for (const entry of providerChain) add(entry);

  // 3. Global env
  if (envChain) {
    for (const pair of envChain.split(',')) {
      const trimmed = pair.trim();
      if (!trimmed) continue;
      const [provider, model] = trimmed.split(':');
      if (provider && model) {
        add({ provider: provider.trim(), model: model.trim() });
      }
    }
  }

  return { entries, currentIndex: 0 };
}

/**
 * Get the next fallback entry, or null if the chain is exhausted.
 * Advances the internal pointer so each entry is tried at most once.
 */
export function nextFallback(chain: FallbackChain): FallbackEntry | null {
  if (chain.currentIndex >= chain.entries.length) return null;
  return chain.entries[chain.currentIndex++];
}

/**
 * Check if the chain has any remaining entries.
 */
export function hasFallback(chain: FallbackChain): boolean {
  return chain.currentIndex < chain.entries.length;
}

/**
 * Parse the CODER_FALLBACK_CHAIN env var into entries for validation/display.
 */
export function parseEnvFallbackChain(envChain: string): FallbackEntry[] {
  const result: FallbackEntry[] = [];
  for (const pair of envChain.split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const [provider, model] = trimmed.split(':');
    if (provider && model) {
      result.push({ provider: provider.trim(), model: model.trim() });
    }
  }
  return result;
}
