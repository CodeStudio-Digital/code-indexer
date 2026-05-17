export interface RateLimitDecision {
  allowed: boolean;
  retryAfterMs: number;  // 0 when allowed
}

/**
 * RateLimiter port — sliding-window gate keyed by an opaque string
 * (typically the AuthContext principal).
 */
export interface RateLimiter {
  tryAcquire(key: string, limit: number, windowMs: number): RateLimitDecision;
}
