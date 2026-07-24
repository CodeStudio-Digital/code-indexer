/**
 * Retry wrapper for single-shot pipeline chat calls.
 *
 * LLM-backed helper pipelines each make a single chat completion. Under a
 * shared provider rate-limit (z.ai `code 1302` / HTTP 429), bounded retry
 * with exponential backoff + jitter, honoring `Retry-After`, recovers the
 * transient family without amplifying load.
 *
 * Scope — we ONLY retry the rate-limit family (HTTP 429/408/5xx, or a body
 * carrying z.ai's `1302` / "rate limit"). Network/abort/timeout errors are
 * deliberately NOT retried: those mean the provider is overloaded or the
 * model is too slow; retrying would only hammer a struggling endpoint.
 */
import type { ChatCallResult } from './llm-chat.js';

export interface ChatRetryOptions {
  /** Max retries AFTER the first attempt. Default 2 → up to 3 attempts. */
  maxRetries?: number;
  /** Exponential base delay (ms) when no `Retry-After` is present. Default 500. */
  baseDelayMs?: number;
  /** Cap for the exponential delay (ms). Default 8000. */
  maxDelayMs?: number;
  /** Jitter fraction in [0,1]. Default 0.5. */
  jitter?: number;
  /** Injectable RNG (tests). */
  rng?: () => number;
  /** Injectable sleep (tests) — bypass real timers. */
  sleepFn?: (ms: number) => Promise<void>;
}

export type ChatErrorKind =
  | 'rate_limit'
  | 'timeout'
  | 'server'
  | 'parse'
  | 'no_binding'
  | 'other';

/** Retry only the rate-limit family. See the module header for the rationale. */
export function isRetryableChatResult(r: Pick<ChatCallResult, 'errorBody' | 'status'>): boolean {
  if (!r.errorBody) return false; // success
  if (hasRateLimitMarker(r.errorBody)) return true;
  if (typeof r.status === 'number') {
    return r.status === 429 || r.status === 408 || (r.status >= 500 && r.status <= 599);
  }
  return false;
}

/** Bucket an errored chat result so the dashboard can show *why* it failed. */
export function errorKindFromChatResult(r: Pick<ChatCallResult, 'errorBody' | 'status'>): ChatErrorKind {
  if (!r.errorBody) return 'other';
  if (r.status === 429 || hasRateLimitMarker(r.errorBody)) return 'rate_limit';
  if (r.status === 408 || isAbortOrTimeout(r.errorBody)) return 'timeout';
  if (typeof r.status === 'number' && r.status >= 500) return 'server';
  return 'other';
}

/**
 * Run `call` and retry the rate-limit family with exp+jitter backoff.
 * Returns the first success, or the last error result after exhausting
 * `maxRetries`. Never throws (mirrors the chat helpers' contract).
 */
export async function withChatRetry(
  call: () => Promise<ChatCallResult>,
  opts: ChatRetryOptions = {},
): Promise<ChatCallResult> {
  const maxRetries = Math.max(0, opts.maxRetries ?? 2);
  const sleep = opts.sleepFn ?? defaultSleep;
  let last: ChatCallResult | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await call();
    last = result;
    if (!result.errorBody) return result; // success
    if (!isRetryableChatResult(result)) return result; // non-retryable error
    if (attempt >= maxRetries) return result; // exhausted
    await sleep(backoffDelayMs(attempt + 1, result.retryAfterMs, opts));
  }
  // Unreachable — the loop always returns — but keeps the type checker happy.
  return last as ChatCallResult;
}

function hasRateLimitMarker(body: string): boolean {
  const b = body.toLowerCase();
  return b.includes('1302') || b.includes('rate limit') || b.includes('too many requests');
}

function isAbortOrTimeout(body: string): boolean {
  return /\b(abort|aborted|timed?\s?out|timeout|etimedout|esockettimedout)\b/.test(body.toLowerCase());
}

/**
 * Exp+jitter backoff. A server-supplied `Retry-After` always wins (plus a
 * touch of upward jitter so concurrent retries do not re-synchronize on the
 * exact boundary). Mirrors the curve in
 * `code-agent/.../provider-retry.ts` (kept local to avoid a
 * services→code-agent import).
 */
function backoffDelayMs(attempt: number, retryAfterMs: number | undefined, opts: ChatRetryOptions): number {
  const jitterFrac = opts.jitter ?? 0.5;
  const rng = opts.rng ?? Math.random;
  if (retryAfterMs && retryAfterMs > 0) {
    return Math.round(retryAfterMs + retryAfterMs * jitterFrac * rng());
  }
  const base = opts.baseDelayMs ?? 500;
  const max = opts.maxDelayMs ?? 8000;
  const a = Math.max(1, Math.floor(attempt));
  const baseExp = Math.min(max, base * 2 ** (a - 1));
  const jit = baseExp * jitterFrac * (rng() * 2 - 1);
  return Math.max(0, Math.round(baseExp + jit));
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
