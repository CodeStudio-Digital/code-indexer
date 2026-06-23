import type { Clock } from '../ports/clock.js';
import type { RateLimitDecision, RateLimiter } from '../ports/rate-limiter.js';

/**
 * In-memory sliding window. Fine for single-node deployments; replace with
 * a Redis-backed implementation when scaling horizontally.
 */
export class MemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, number[]>();

  constructor(private readonly clock: Clock) {}

  tryAcquire(key: string, limit: number, windowMs: number): RateLimitDecision {
    if (limit <= 0) return { allowed: true, retryAfterMs: 0 };

    const now = this.clock.now();
    const cutoff = now - windowMs;
    const bucket = (this.buckets.get(key) ?? []).filter((t) => t > cutoff);

    if (bucket.length >= limit) {
      const oldest = bucket[0];
      const retryAfterMs = Math.max(0, oldest + windowMs - now);
      this.buckets.set(key, bucket);
      return { allowed: false, retryAfterMs };
    }

    bucket.push(now);
    this.buckets.set(key, bucket);
    return { allowed: true, retryAfterMs: 0 };
  }

  /** Called periodically to bound memory usage. */
  sweep(): void {
    const now = this.clock.now();
    for (const [key, bucket] of this.buckets) {
      const kept = bucket.filter((t) => t > now - 60_000);
      if (kept.length === 0) this.buckets.delete(key);
      else this.buckets.set(key, kept);
    }
  }
}
