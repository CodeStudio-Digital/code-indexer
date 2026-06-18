/**
 * Route-layer rate limiting. A handler calls `enforceRateLimit` with one or more
 * rules (keyed by purpose + IP/account/email-hash); the first rule to trip yields
 * a 429 with `Retry-After`. Keys are opaque DO names — never PII (callers pass
 * pre-hashed IP/email). No-op when the binding is absent (keeps local dev simple).
 */
import type { Context } from 'hono';
import { createRateLimiter } from '../infra/rate-limiter.js';
import type { Env } from '../env.js';

export interface RateRule {
  /** Purpose-prefixed key, e.g. `pwreset:ip:<ipHash>`. */
  key: string;
  limit: number;
  windowMs: number;
}

export async function enforceRateLimit(c: Context<{ Bindings: Env }>, rules: RateRule[]): Promise<Response | null> {
  const ns = c.env.RATE_LIMIT;
  if (!ns) return null; // binding not provisioned (local/dev) → skip
  const rl = createRateLimiter(ns);
  for (const r of rules) {
    const { allowed, retryAfterMs } = await rl.consume(r.key, r.limit, r.windowMs);
    if (!allowed) {
      c.header('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
      return c.json({ code: 'rate_limited', message: 'Too many requests. Try again later.', details: { retryAfterMs } }, 429);
    }
  }
  return null;
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
