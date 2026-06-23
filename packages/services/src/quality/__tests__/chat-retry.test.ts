/**
 * Tests for the classifier chat retry wrapper (`chat-retry.ts`) and the
 * `Retry-After` parser (`llm-chat.ts`).
 *
 * Contract under test:
 *   - Only the rate-limit family (429/408/5xx, or a body carrying z.ai's
 *     1302 / "rate limit") is retried. Abort/timeout without a status is NOT.
 *   - Backoff honors a server `Retry-After` exactly (with rng=0, no jitter).
 *   - Retries are bounded by `maxRetries`; `maxRetries: 0` disables them.
 */
import { describe, expect, it } from 'vitest';
import type { ChatCallResult } from '../llm-chat.js';
import { parseRetryAfter } from '../llm-chat.js';
import {
  withChatRetry,
  isRetryableChatResult,
  errorKindFromChatResult,
} from '../chat-retry.js';

const ok = (): ChatCallResult => ({ content: '{"verdict":"ok"}', latencyMs: 1 });
const fail = (p: Partial<ChatCallResult>): ChatCallResult => ({ content: '', errorBody: 'boom', latencyMs: 1, ...p });

/** A fake chat fn returning a fixed sequence; last entry repeats. Tracks calls. */
function recorder(results: ChatCallResult[]) {
  let calls = 0;
  const fn = async (): Promise<ChatCallResult> => {
    const r = results[Math.min(calls, results.length - 1)];
    calls += 1;
    return r;
  };
  return { fn, getCalls: () => calls };
}

const RATE_LIMIT_BODY = '{"error":{"code":"1302","message":"Rate limit reached for requests"}}';

describe('isRetryableChatResult', () => {
  it('treats a success (no errorBody) as not retryable', () => {
    expect(isRetryableChatResult(ok())).toBe(false);
  });
  it('retries HTTP 429 / 408 / 5xx', () => {
    expect(isRetryableChatResult(fail({ status: 429 }))).toBe(true);
    expect(isRetryableChatResult(fail({ status: 408 }))).toBe(true);
    expect(isRetryableChatResult(fail({ status: 503 }))).toBe(true);
  });
  it('retries a z.ai 1302 body even without a status', () => {
    expect(isRetryableChatResult(fail({ errorBody: RATE_LIMIT_BODY }))).toBe(true);
  });
  it('does NOT retry other 4xx', () => {
    expect(isRetryableChatResult(fail({ status: 404 }))).toBe(false);
    expect(isRetryableChatResult(fail({ status: 400 }))).toBe(false);
  });
  it('does NOT retry abort/timeout without a status', () => {
    expect(isRetryableChatResult(fail({ errorBody: 'This operation was aborted' }))).toBe(false);
  });
});

describe('errorKindFromChatResult', () => {
  it('buckets rate_limit / timeout / server / other', () => {
    expect(errorKindFromChatResult(fail({ status: 429 }))).toBe('rate_limit');
    expect(errorKindFromChatResult(fail({ errorBody: RATE_LIMIT_BODY }))).toBe('rate_limit');
    expect(errorKindFromChatResult(fail({ errorBody: 'This operation was aborted' }))).toBe('timeout');
    expect(errorKindFromChatResult(fail({ status: 500 }))).toBe('server');
    expect(errorKindFromChatResult(fail({ status: 400, errorBody: 'bad request' }))).toBe('other');
  });
});

describe('parseRetryAfter', () => {
  it('parses delta-seconds to ms', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter('0')).toBe(0);
  });
  it('returns undefined for null/garbage', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('not-a-date')).toBeUndefined();
  });
});

describe('withChatRetry', () => {
  const sleepFn = (): Promise<void> => Promise.resolve();
  const noJitter = { sleepFn, rng: () => 0 };

  it('returns immediately on success (1 call)', async () => {
    const rec = recorder([ok()]);
    const r = await withChatRetry(rec.fn, noJitter);
    expect(r.errorBody).toBeUndefined();
    expect(rec.getCalls()).toBe(1);
  });

  it('retries a 429 then succeeds (2 calls)', async () => {
    const rec = recorder([fail({ status: 429 }), ok()]);
    const r = await withChatRetry(rec.fn, noJitter);
    expect(r.errorBody).toBeUndefined();
    expect(rec.getCalls()).toBe(2);
  });

  it('gives up after maxRetries on a persistent rate-limit', async () => {
    const rec = recorder([fail({ status: 429 })]);
    const r = await withChatRetry(rec.fn, { ...noJitter, maxRetries: 2 });
    expect(r.errorBody).toBeDefined();
    expect(rec.getCalls()).toBe(3); // 1 initial + 2 retries
  });

  it('does not retry a non-retryable error (404)', async () => {
    const rec = recorder([fail({ status: 404 })]);
    const r = await withChatRetry(rec.fn, noJitter);
    expect(rec.getCalls()).toBe(1);
    expect(r.status).toBe(404);
  });

  it('maxRetries:0 disables retry', async () => {
    const rec = recorder([fail({ status: 429 })]);
    await withChatRetry(rec.fn, { ...noJitter, maxRetries: 0 });
    expect(rec.getCalls()).toBe(1);
  });

  it('honors Retry-After exactly (rng=0 → no extra jitter)', async () => {
    const delays: number[] = [];
    const rec = recorder([fail({ status: 429, retryAfterMs: 4000 }), ok()]);
    await withChatRetry(rec.fn, { sleepFn: (ms) => { delays.push(ms); return Promise.resolve(); }, rng: () => 0 });
    expect(delays).toEqual([4000]);
  });
});
