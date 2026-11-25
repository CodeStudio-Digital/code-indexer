/**
 * ConcurrencyPolicy — caps the number of concurrently running company
 * subordinates. Prevents a buggy master from spawning 50 agents and
 * collapsing the system.
 *
 * Configurable via CODER_COMPANY_MAX_SUBORDINATES (default 10).
 *
 * The policy is advisory: tryAcquire returns a result object; the caller
 * (orchestrator) decides whether to reject with an actionable error so
 * the master can resume dispatch when a slot opens.
 */

export interface ConcurrencyOpts {
  /** Max concurrent subordinates. Default 10. */
  maxConcurrent?: number;
}

export interface ConcurrencyResult {
  ok: boolean;
  /** When !ok, an actionable message the caller can forward to the master LLM. */
  message?: string;
  current: number;
  max: number;
}

export class ConcurrencyPolicy {
  private readonly max: number;

  constructor(opts: ConcurrencyOpts = {}) {
    // Support both env var names: CODER_COMPANY_MAX_SUBORDINATES (new)
    // takes precedence, falling back to COMPANY_MAX_CONCURRENT_SUBORDINATES
    // for backwards compatibility with existing deployments.
    const envMax = Number(
      process.env.CODER_COMPANY_MAX_SUBORDINATES ??
      process.env.COMPANY_MAX_CONCURRENT_SUBORDINATES
    );
    this.max = Number.isFinite(envMax) && envMax > 0
      ? envMax
      : (opts.maxConcurrent ?? 10);
  }

  check(currentRunning: number, sessionLimit?: number | null): ConcurrencyResult {
    const max = sessionLimit && Number.isInteger(sessionLimit) && sessionLimit > 0 ? Math.min(this.max, sessionLimit) : this.max;
    if (currentRunning >= max) {
      return {
        ok: false,
        current: currentRunning,
        max,
        message:
          `Concurrent subordinate cap reached (${currentRunning}/${max}). ` +
          `The Company will notify you when a specialist finishes. Dispatch the remaining work then.`,
      };
    }
    return { ok: true, current: currentRunning, max };
  }

  get limit(): number {
    return this.max;
  }
}
