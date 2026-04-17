import type { RateLimiter } from '../ports/rate-limiter.js';
import { err, ok, type Result } from './result.js';

export class EnforceRateLimit {
  constructor(
    private readonly limiter: RateLimiter,
    private readonly limitPerMin: number,
  ) {}

  execute(principal: string): Result<void> {
    const decision = this.limiter.tryAcquire(principal, this.limitPerMin, 60_000);
    if (decision.allowed) return ok(undefined);
    return err({ kind: 'rate_limited', retryAfterMs: decision.retryAfterMs });
  }
}
