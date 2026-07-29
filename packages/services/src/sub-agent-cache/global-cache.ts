/**
 * Module-level holder for the global sub-agent cache.
 *
 * Installed once by the app's boot path with the configured
 * `SubAgentResultCache`. The runtime path (the `spawn_subagent` tool
 * handler in code-agent) calls `tryGlobalSubAgentRead` BEFORE running
 * the subagent — on a hit, returns immediately without spawning a
 * fresh runner. On a miss, runs the subagent and stores the result
 * via `writeGlobalSubAgentResult`.
 *
 * Mirror of `setGlobalToolSelectionFilter` and
 * the other process-wide pipeline holders. Same singleton-holder
 * approach the codebase uses for cross-cutting concerns.
 */
import type {
  CacheKeyInput,
  SubAgentResultCache,
} from './sub-agent-result-cache.js';

let globalCache: SubAgentResultCache | undefined;
let enabled = false;

export function setGlobalSubAgentCache(cache: SubAgentResultCache | undefined, isEnabled: boolean): void {
  globalCache = cache;
  enabled = isEnabled;
}

export function isGlobalSubAgentCacheEnabled(): boolean {
  return enabled && globalCache != null;
}

/**
 * Read from the cache. Returns the cached payload (whatever shape was
 * written) when:
 *   - cache is installed AND enabled
 *   - key matches a non-expired row
 * Otherwise returns null and the caller falls through to the real spawn.
 */
export function tryGlobalSubAgentRead<T>(
  keyInput: CacheKeyInput,
): { result: T; cached: true; ageMs: number; hitCount: number } | null {
  if (!enabled || !globalCache) return null;
  try {
    const key = globalCache.buildKey(keyInput);
    return globalCache.tryRead<T>(key);
  } catch {
    return null;
  }
}

/**
 * Persist a fresh sub-agent result. No-op when the cache is disabled
 * or not installed.
 */
export function writeGlobalSubAgentResult<T>(
  keyInput: CacheKeyInput,
  result: T,
): void {
  if (!enabled || !globalCache) return;
  try {
    const key = globalCache.buildKey(keyInput);
    globalCache.write(key, result);
  } catch {
    /* best-effort */
  }
}
