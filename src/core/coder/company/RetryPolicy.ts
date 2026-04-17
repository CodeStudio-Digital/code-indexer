/**
 * RetryPolicy — classifies errors as transient vs permanent and tracks
 * retry attempts per subordinate.
 *
 * Transient triggers (worth auto-retrying):
 *   - HTTP 429 (rate limit)
 *   - HTTP 5xx (server errors)
 *   - Timeouts (408, 504, or message contains "timeout")
 *   - Network drops (ECONNRESET, ECONNREFUSED, ETIMEDOUT)
 *
 * Permanent (don't retry — notify master directly):
 *   - Tool misuse, logic errors, 4xx (non-429), aborts
 */

const TRANSIENT_PATTERNS = [
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
  /** Max auto-retries before giving up and notifying master. Default 1. */
  maxAutoRetries?: number;
}

/**
 * Per-subordinate retry bookkeeping. Lightweight — just tracks the
 * number of retries burned per agent_run_id.
 */
export class RetryPolicy {
  private readonly maxRetries: number;
  private readonly used = new Map<number, number>();

  constructor(opts: RetryPolicyOpts = {}) {
    const envDefault = Number(process.env.CODER_SUBORDINATE_MAX_RETRIES);
    this.maxRetries = Number.isFinite(envDefault) && envDefault >= 0
      ? envDefault
      : (opts.maxAutoRetries ?? 1);
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

  /** Total budget per subordinate. */
  get maxAttempts(): number {
    return this.maxRetries;
  }

  /** Forget retry count when the subordinate finishes successfully. */
  clear(agentRunId: number): void {
    this.used.delete(agentRunId);
  }
}
