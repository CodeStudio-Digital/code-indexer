/**
 * Retry-with-backoff for individual task dispatches (PR-C).
 *
 * Wraps the per-attempt subagent runner with a small state machine:
 *
 *   ┌──────────┐  fatal       ┌────────┐
 *   │ attempt 0│─────────────▶│ return │
 *   └──────────┘              └────────┘
 *         │ transient + has-retries
 *         ▼
 *   ┌──────────┐  fatal       ┌────────┐
 *   │ attempt 1│─────────────▶│ return │
 *   └──────────┘              └────────┘
 *         │ transient + has-retries
 *         ▼
 *   ... up to CODER_TASK_MAX_RETRIES + 1 total attempts.
 *
 * The classifier reuses `nonRetryableProviderErrorReason` so quota
 * exhaustion is treated identically to the main runner's retry path.
 * Subagent-side aborts triggered by the quality watchdog
 * (`subagent_quality_watchdog`) are CLASSIFIED as transient — the
 * agent got lost in a thought loop; a fresh attempt with a clean
 * prompt usually recovers.
 */
import { nonRetryableProviderErrorReason, backoffDelayMs } from '@mcp/code-agent/core/runner/provider-retry.js';
import { setTimeout as sleepTimer } from 'node:timers/promises';

export type RetryVerdict = 'transient' | 'fatal';

/**
 * Map an arbitrary error message (or thrown Error) onto our 2-way verdict.
 * Unrecognized error messages use the bounded transient policy. Uncertain
 * effects are different: they require reconciliation and never authorize replay.
 */
export function classifyError(errOrMessage: unknown): RetryVerdict {
  const err = errOrMessage instanceof Error ? errOrMessage : new Error(stringifyError(errOrMessage));
  // First consult the provider-retry classifier — quota/credit errors are always fatal.
  if (nonRetryableProviderErrorReason(err, err) !== null) return 'fatal';

  const msg = stringifyError(errOrMessage).toLowerCase();
  if (/outcome[_ ]unknown|effect[_ ]unconfirmed|result[_ ]ambiguous/.test(msg)) return 'fatal';

  // Quality watchdog abort (PR-C) — transient by design. The retry
  // sequence drops history that the model got stuck on.
  if (msg.includes('subagent_quality_watchdog')) return 'transient';
  if (msg.includes('subagent_aborted_by_parent')) return 'transient';

  // Network / IO transient signals.
  if (msg.includes('etimedout') || msg.includes('econnreset')) return 'transient';
  if (msg.includes('econnrefused') || msg.includes('enotfound')) return 'transient';
  if (msg.includes('socket hang up') || msg.includes('network error')) return 'transient';
  if (/\btimeout\b/.test(msg)) return 'transient';

  // HTTP families — 429 (rate limit) + 5xx are transient.
  if (msg.includes('rate limit') || msg.includes('rate-limit') || msg.includes('too many requests')) return 'transient';
  if (/\b429\b/.test(msg)) return 'transient';
  if (/\b5\d\d\b/.test(msg)) return 'transient';

  // Auth / validation / refusal — fatal (retry wastes tokens).
  if (msg.includes('401') || msg.includes('403') || msg.includes('unauthorized')) return 'fatal';
  if (msg.includes('invalid_request') || msg.includes('schema validation')) return 'fatal';
  if (msg.includes('refused by dedup') || msg.includes('tuple-hash')) return 'fatal';
  if (msg.includes('tool gate refusal') || msg.includes('plan mode')) return 'fatal';
  if (msg.includes('approved execution mode')) return 'fatal'; // inline-all refusal

  // Default: unknown errors → transient (bounded by retry cap).
  return 'transient';
}

function stringifyError(err: unknown): string {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message + (err.stack ? `\n${err.stack}` : '');
  try { return JSON.stringify(err); } catch { return String(err); }
}

// ─── Retry config ───────────────────────────────────────────────

export interface TaskRetryConfig {
  /** Maximum number of EXTRA attempts after the first one fails. */
  maxRetries: number;
  /** Initial backoff (ms) — first retry waits this long. */
  initialMs: number;
  /** Backoff ceiling (ms). */
  maxMs: number;
  /** Symmetric jitter (0..1). */
  jitter: number;
}

export function loadRetryConfig(): TaskRetryConfig {
  return {
    maxRetries: 2,
    initialMs: 1_000,
    maxMs: 16_000,
    jitter: 0.25,
  };
}

// ─── Wrapper ────────────────────────────────────────────────────

export interface AttemptResult<T> {
  result: T;
  /** True when the attempt is considered done — DON'T retry. */
  shouldStop: boolean;
  /** Error message used by the classifier; empty if no error. */
  errorMessage?: string;
  effectOutcome?: 'unknown';
}

export interface DispatchWithRetryOpts<T> {
  signal?: AbortSignal;
  config?: TaskRetryConfig;
  /** Override sleep — tests pass a synchronous resolver. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Telemetry hook fired before each backoff. */
  onRetry?: (info: { attempt: number; nextAttempt: number; delayMs: number; verdict: RetryVerdict; errorMessage: string }) => void;
  /** Telemetry hook fired when the loop bails (success OR fatal OR cap-exhausted). */
  onFinish?: (info: { attempts: number; verdict: RetryVerdict | null; errorMessage?: string }) => void;
}

/**
 * Generic retry harness — calls `attempt(idx)` up to `maxRetries+1` times,
 * stopping on `shouldStop=true`, on a `fatal` classification, or when the
 * cap is exhausted. Returns the LAST attempt result + total attempt count.
 *
 * The `attempt(idx)` function is responsible for actually invoking the
 * subagent + writing its own per-attempt persistence row (passes
 * `idx` to `persist.recordTaskFinished({ attempt: idx, ... })`).
 */
export async function dispatchWithRetry<T>(
  attempt: (attemptIdx: number) => Promise<AttemptResult<T>>,
  opts: DispatchWithRetryOpts<T> = {},
): Promise<{ result: T; attempts: number }> {
  const cfg = opts.config ?? loadRetryConfig();
  const sleep = opts.sleep ?? defaultSleep;
  let last: AttemptResult<T> | null = null;
  const maxAttempts = cfg.maxRetries + 1;

  for (let i = 0; i < maxAttempts; i++) {
    opts.signal?.throwIfAborted();
    last = await attempt(i);
    if (last.effectOutcome === 'unknown') {
      opts.onFinish?.({ attempts: i + 1, verdict: 'fatal', errorMessage: 'outcome_unknown: reconcile the previous effect before retrying' });
      return { result: last.result, attempts: i + 1 };
    }
    opts.signal?.throwIfAborted();
    if (last.shouldStop) {
      opts.onFinish?.({ attempts: i + 1, verdict: null });
      return { result: last.result, attempts: i + 1 };
    }
    const errMsg = last.errorMessage ?? '';
    const verdict = classifyError(errMsg);
    const isLast = i === maxAttempts - 1;
    if (verdict === 'fatal' || isLast) {
      opts.onFinish?.({ attempts: i + 1, verdict, errorMessage: errMsg });
      return { result: last.result, attempts: i + 1 };
    }
    const delayMs = backoffDelayMs(i + 1, { initialMs: cfg.initialMs, maxMs: cfg.maxMs, jitter: cfg.jitter });
    opts.onRetry?.({ attempt: i, nextAttempt: i + 1, delayMs, verdict, errorMessage: errMsg });
    await sleep(delayMs, opts.signal);
  }
  // Unreachable — the loop always returns inside, but TS needs the fallback.
  return { result: last!.result, attempts: maxAttempts };
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return sleepTimer(Math.max(0, ms), undefined, { signal });
}
