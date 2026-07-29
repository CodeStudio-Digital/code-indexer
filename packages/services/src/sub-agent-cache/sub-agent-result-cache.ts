/**
 * SubAgentResultCache — consumer-side facade over the
 * SubAgentResultCacheStore (migration 081).
 *
 * Usage in a runner:
 *
 *   const key = cache.buildKey({ prompt, projectIds, recentMutations, agentType: 'Explore' });
 *   const hit = cache.tryRead(key);
 *   if (hit) return hit.result;
 *   const result = await runSubAgentForReal(...);
 *   cache.write(key, result);
 *   return result;
 *
 * TTL defaults follow the plan:
 *   - Explore:         30 minutes
 *   - Plan:             5 minutes
 *   - general-purpose: 15 minutes
 * Anything else: 10 minutes (conservative default).
 */
import { createHash } from 'node:crypto';
import type {
  SubAgentCacheRow,
  SubAgentResultCacheStore,
} from '@mcp/store/sub-agent-result-cache-store.js';

export type AgentType = 'Explore' | 'Plan' | 'general-purpose' | string;

export interface SubAgentKey {
  promptHash: string;
  contextDigest: string;
  agentType: AgentType;
}

export interface CacheKeyInput {
  prompt: string;
  projectIds?: number[];
  /**
   * Hashes of recent file mutations within the session — drives cache
   * invalidation when the working tree changes. Callers maintain this list;
   * the cache treats it as opaque.
   */
  recentMutations?: string[];
  agentType: AgentType;
}

export interface SubAgentReadResult<T> {
  result: T;
  cached: true;
  hitCount: number;
  createdAt: string;
  ageMs: number;
}

export interface SubAgentResultCacheConfig {
  /** Per-agent-type TTLs in seconds. Defaults from the plan. */
  ttlSeconds?: Partial<Record<AgentType, number>>;
  /** Fallback TTL if the agent type isn't in `ttlSeconds`. Default 600s. */
  defaultTtlSeconds?: number;
}

const PLAN_TTL_DEFAULTS: Record<string, number> = {
  Explore: 30 * 60,
  Plan: 5 * 60,
  'general-purpose': 15 * 60,
};

export class SubAgentResultCache {
  private readonly cfg: Required<SubAgentResultCacheConfig>;

  constructor(
    private store: SubAgentResultCacheStore,
    config: SubAgentResultCacheConfig = {},
  ) {
    this.cfg = {
      ttlSeconds: { ...PLAN_TTL_DEFAULTS, ...config.ttlSeconds },
      defaultTtlSeconds: config.defaultTtlSeconds ?? 10 * 60,
    };
  }

  /** Build a deterministic cache key from typical inputs. */
  buildKey(input: CacheKeyInput): SubAgentKey {
    const promptHash = createHash('sha256').update(input.prompt).digest('hex');
    const ctxParts = [
      JSON.stringify(input.projectIds ?? []),
      JSON.stringify(input.recentMutations ?? []),
      input.agentType,
    ];
    const contextDigest = createHash('sha256').update(ctxParts.join('::')).digest('hex');
    return { promptHash, contextDigest, agentType: input.agentType };
  }

  /** Returns the cached result if a fresh (non-expired) row exists. */
  tryRead<T>(key: SubAgentKey): SubAgentReadResult<T> | null {
    const row = this.store.lookup({
      prompt_hash: key.promptHash,
      context_digest: key.contextDigest,
      agent_type: key.agentType,
    });
    if (!row) return null;
    let parsed: T;
    try {
      parsed = JSON.parse(row.result_json) as T;
    } catch {
      // Corrupt row — treat as miss, let caller re-run.
      this.store.delete(row.id);
      return null;
    }
    const createdAtMs = this.parseSqliteTs(row.created_at);
    return {
      result: parsed,
      cached: true,
      hitCount: row.hit_count,
      createdAt: row.created_at,
      ageMs: Number.isFinite(createdAtMs) ? Date.now() - createdAtMs : 0,
    };
  }

  /** Write a fresh row, replacing any expired one for the same key. */
  write<T>(key: SubAgentKey, result: T): void {
    const ttl = this.cfg.ttlSeconds[key.agentType] ?? this.cfg.defaultTtlSeconds;
    this.store.upsert({
      prompt_hash: key.promptHash,
      context_digest: key.contextDigest,
      agent_type: key.agentType,
      result_json: JSON.stringify(result),
      ttl_seconds: ttl,
    });
  }

  /** Sweeper for expired rows; expected to run periodically. */
  sweep(): number {
    return this.store.sweepExpired();
  }

  /** Diagnostics for admin UI. */
  stats(): ReturnType<SubAgentResultCacheStore['stats']> {
    return this.store.stats();
  }

  /**
   * Parse SQLite's 'YYYY-MM-DD HH:MM:SS' format. Returns NaN on failure.
   * Adding the 'Z' suffix tells Date to interpret it as UTC, matching
   * SQLite's `datetime('now')` semantics.
   */
  private parseSqliteTs(s: string): number {
    return new Date(s.replace(' ', 'T') + 'Z').getTime();
  }
}

/** Convenience: get the default TTL map (read-only). */
export function defaultSubAgentTtls(): Record<string, number> {
  return { ...PLAN_TTL_DEFAULTS };
}
