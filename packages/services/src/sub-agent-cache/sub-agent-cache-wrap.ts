/**
 * withSubAgentCache — high-level helper that wraps a sub-agent invocation
 * with the cache check/write pattern.
 *
 * Pattern:
 *
 *   const result = await withSubAgentCache(
 *     cache,
 *     { prompt, projectIds, agentType: 'Explore' },
 *     async () => runActualSubAgent(...),
 *     { sessionId },
 *   );
 *
 * On cache hit, `runFn` is never called. On miss, `runFn` runs and the
 * result is persisted. The optional `telemetry` callback fires with one
 * of `'hit' | 'miss' | 'write'` so consumers can surface cache stats.
 */
import type {
  AgentType,
  CacheKeyInput,
  SubAgentReadResult,
  SubAgentResultCache,
} from './sub-agent-result-cache.js';

export interface WithCacheOptions {
  sessionId?: number | null;
  /** Skip the cache read (always re-run). Useful for forced refreshes. */
  bypassRead?: boolean;
  /** Skip the cache write (e.g. when the result is known-to-be-unstable). */
  bypassWrite?: boolean;
  /** Telemetry callback fired on hit/miss/write events. */
  onCacheEvent?: (event: 'hit' | 'miss' | 'write', meta: { agentType: AgentType; ageMs?: number }) => void;
}

export interface CachedRunResult<T> {
  result: T;
  cached: boolean;
  /** Age of the cached entry, ms (0 on miss). */
  ageMs: number;
  /** How many times this key has been hit (1 after a fresh write). */
  hitCount: number;
}

/**
 * Wrap a sub-agent invocation with cache check/write.
 *
 * The cache key is the (promptHash, contextDigest, agentType) tuple
 * computed by `cache.buildKey(...)`. Two different sessions asking the
 * same question with the same context share a cache hit — desirable
 * when the same project structure is being analyzed multiple times.
 */
export async function withSubAgentCache<T>(
  cache: SubAgentResultCache,
  keyInput: CacheKeyInput,
  runFn: () => Promise<T>,
  options: WithCacheOptions = {},
): Promise<CachedRunResult<T>> {
  const key = cache.buildKey(keyInput);
  if (!options.bypassRead) {
    const hit = cache.tryRead<T>(key, { sessionId: options.sessionId });
    if (hit) {
      options.onCacheEvent?.('hit', { agentType: keyInput.agentType, ageMs: hit.ageMs });
      return {
        result: hit.result,
        cached: true,
        ageMs: hit.ageMs,
        hitCount: hit.hitCount,
      };
    }
  }
  options.onCacheEvent?.('miss', { agentType: keyInput.agentType });
  const result = await runFn();
  if (!options.bypassWrite) {
    cache.write(key, result, { sessionId: options.sessionId });
    options.onCacheEvent?.('write', { agentType: keyInput.agentType });
  }
  return { result, cached: false, ageMs: 0, hitCount: 1 };
}

/**
 * Convenience type for the cache-event callback so consumers can build
 * their own telemetry without re-declaring the signature.
 */
export type SubAgentCacheEvent = Parameters<NonNullable<WithCacheOptions['onCacheEvent']>>[0];

/**
 * Re-export `CacheKeyInput` so callers don't need two imports.
 */
export type { CacheKeyInput, AgentType, SubAgentReadResult };
