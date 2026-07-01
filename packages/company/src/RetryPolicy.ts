/**
 * RetryPolicy — classifies errors as transient vs permanent and tracks
 * retry attempts per subordinate.
 *
 * Transient triggers (worth auto-retrying):
 *   - HTTP 400 from the provider (often model/message-shape specific; fallback may recover)
 *   - HTTP 429 (rate limit)
 *   - HTTP 5xx (server errors)
 *   - Timeouts (408, 504, or message contains "timeout")
 *   - Network drops (ECONNRESET, ECONNREFUSED, ETIMEDOUT)
 *
 * Permanent (don't retry — notify master directly):
 *   - Tool misuse, logic errors, non-provider 4xx, aborts
 */

const TRANSIENT_PATTERNS = [
  /\b400\b/,
  /\b429\b/,
  /\b(5\d{2})\b/,
  /\btimeout\b/i,
  /ECONNRESET/,
  /ECONNREFUSED/,
  /ETIMEDOUT/,
  /EAI_AGAIN/,
  /fetch failed/i,
  /socket hang up/i,
];

export function isTransientError(detail: string | undefined | null): boolean {
  if (!detail) return false;
  return TRANSIENT_PATTERNS.some((p) => p.test(detail));
}

export interface RetryPolicyOpts {
  /**
   * Max auto-retries before giving up and notifying master. Default 1.
   * Honored from `CODER_SUBORDINATE_MAX_RETRIES` when set, bounded by
   * MAX_SAFE_RETRIES so a persistently-transient error can't loop forever.
   */
  maxAutoRetries?: number;
  /** Base backoff in ms for the first retry (doubles each attempt). Default 2000. */
  baseBackoffMs?: number;
  /** Hard ceiling on a single backoff delay. Default 30000. */
  maxBackoffMs?: number;
}

/**
 * Upper safety bound on auto-retries regardless of configuration. Keeps a
 * stuck-but-transient failure (e.g. a provider returning 429 forever) from
 * burning unbounded tokens/spawns. Operators who genuinely want more can
 * raise it here; the env var is honored up to this ceiling.
 */
const MAX_SAFE_RETRIES = 10;

/**
 * Per-subordinate retry bookkeeping. Lightweight — tracks the number of
 * retries burned per agent_run_id and computes the backoff before each one.
 */
export class RetryPolicy {
  private readonly maxRetries: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly used = new Map<number, number>();

  constructor(opts: RetryPolicyOpts = {}) {
    const envDefault = Number(process.env.CODER_SUBORDINATE_MAX_RETRIES);
    const configured = Number.isFinite(envDefault) && envDefault >= 0
      ? envDefault
      : (opts.maxAutoRetries ?? 1);
    // Honor the configured value (the old code clamped it to 1, silently
    // ignoring CODER_SUBORDINATE_MAX_RETRIES); only the safety ceiling caps it.
    this.maxRetries = Math.max(0, Math.min(configured, MAX_SAFE_RETRIES));
    this.baseBackoffMs = Math.max(0, opts.baseBackoffMs ?? 2000);
    this.maxBackoffMs = Math.max(this.baseBackoffMs, opts.maxBackoffMs ?? 30_000);
  }

  /**
   * Returns true if the caller should auto-retry the given subordinate,
   * consuming one retry budget. Returns false if the error is permanent
   * or the budget is exhausted.
   */
  shouldRetry(agentRunId: number, errorDetail: string | null | undefined): boolean {
    if (!isTransientError(errorDetail)) return false;
    const already = this.used.get(agentRunId) ?? 0;
    if (already >= this.maxRetries) return false;
    this.used.set(agentRunId, already + 1);
    return true;
  }

  /** How many retries have been consumed for this subordinate (for UI/board). */
  usedCount(agentRunId: number): number {
    return this.used.get(agentRunId) ?? 0;
  }

  /**
   * Bounded exponential backoff (with jitter) to wait before the retry that
   * `shouldRetry` just granted. Call AFTER `shouldRetry` returns true — it
   * keys off the consumed-attempt count, so attempt 1 → ~base, attempt 2 →
   * ~2×base, capped at `maxBackoffMs`.
   *
   * `retryAfterMs` (from a provider `Retry-After` header, when the caller can
   * parse one out of the error) takes precedence as a floor — we never retry
   * sooner than the provider asked.
   */
  backoffMs(agentRunId: number, retryAfterMs?: number): number {
    const attempt = Math.max(1, this.used.get(agentRunId) ?? 1);
    const exp = this.baseBackoffMs * 2 ** (attempt - 1);
    const capped = Math.min(exp, this.maxBackoffMs);
    // ±20% jitter so a fleet retrying together doesn't thunder-herd the provider.
    const jittered = capped * (0.8 + Math.random() * 0.4);
    return Math.max(jittered, retryAfterMs ?? 0);
  }

  /** Total budget per subordinate. */
  get maxAttempts(): number {
    return this.maxRetries;
  }

  /** Forget retry count when the subordinate finishes successfully. */
  clear(agentRunId: number): void {
    this.used.delete(agentRunId);
  }
}
