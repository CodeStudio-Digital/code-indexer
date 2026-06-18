/** RateLimiter port adapter over RateLimitDO. Each key → one serialized DO. */
import type { RateLimiter } from '@cloudstudio/cloud-kernel';

export function createRateLimiter(ns: DurableObjectNamespace): RateLimiter {
  return {
    async consume(key, limit, windowMs) {
      const res = await ns
        .get(ns.idFromName(key))
        .fetch(`https://rl.internal/consume?limit=${limit}&windowMs=${windowMs}`);
      return (await res.json()) as { allowed: boolean; retryAfterMs: number };
    },
  };
}
