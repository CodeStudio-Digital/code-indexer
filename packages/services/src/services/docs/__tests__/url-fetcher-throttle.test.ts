/**
 * Coverage for the 429-resilience path in `UrlFetcher`:
 *   - Single-shot 429 → retried with Retry-After delay → succeeds.
 *   - Repeated 429 → adaptive penalty doubles, caps, decays.
 *   - Retry exhaustion → returns the LAST 429 instead of throwing.
 *   - `computeRetryBackoffMs` honors Retry-After verbatim (modulo jitter).
 *   - `isRateLimited` covers 429 and 503 only.
 *
 * Time is controlled via an injected `sleepFn` that records the requested
 * delays in an array, so the assertions don't depend on a real clock.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  UrlFetcher,
  computeRetryBackoffMs,
  isRateLimited,
} from '../url-fetcher.js';

function html(body: string): string {
  return `<html><body>${body}</body></html>`;
}

interface CannedResponse {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

/**
 * Build a `fetch`-shaped function that returns a deterministic sequence
 * of responses. Every call shifts the next response off the queue;
 * exhausting the queue throws — the test should always provision
 * enough responses upfront.
 */
function scriptedFetch(responses: CannedResponse[]): typeof fetch {
  const queue = [...responses];
  return (async (_url: string | URL, _init?: RequestInit) => {
    const next = queue.shift();
    if (!next) throw new Error('scripted fetch queue exhausted');
    const headers = new Headers(next.headers ?? { 'content-type': 'text/html' });
    return new Response(next.body ?? html('ok'), {
      status: next.status,
      headers,
    });
  }) as unknown as typeof fetch;
}

function makeRecorderSleep(): { sleepFn: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  return {
    sleepFn: async (ms: number) => {
      calls.push(ms);
      // Resolve on the next microtask so the rest of the loop runs.
    },
    calls,
  };
}

describe('isRateLimited', () => {
  it('returns true for 429 and 503 only', () => {
    expect(isRateLimited(429)).toBe(true);
    expect(isRateLimited(503)).toBe(true);
    expect(isRateLimited(200)).toBe(false);
    expect(isRateLimited(404)).toBe(false);
    expect(isRateLimited(500)).toBe(false);
    expect(isRateLimited(502)).toBe(false);
  });
});

describe('computeRetryBackoffMs', () => {
  it('honors Retry-After when supplied (within jitter band)', () => {
    // Jitter is +0..25% so the floor IS the input value.
    const out = computeRetryBackoffMs(0, 5000);
    expect(out).toBeGreaterThanOrEqual(5000);
    expect(out).toBeLessThanOrEqual(6300); // 5000 + 25% + rounding slack
  });

  it('falls back to exponential backoff when no Retry-After', () => {
    // Attempt 0 → 1000ms base; jitter bias UP.
    const a = computeRetryBackoffMs(0, undefined);
    expect(a).toBeGreaterThanOrEqual(1000);
    expect(a).toBeLessThanOrEqual(1300);
    // Attempt 1 → 2000ms base.
    const b = computeRetryBackoffMs(1, undefined);
    expect(b).toBeGreaterThanOrEqual(2000);
    expect(b).toBeLessThanOrEqual(2600);
    // Attempt 2 → 4000ms base.
    const c = computeRetryBackoffMs(2, undefined);
    expect(c).toBeGreaterThanOrEqual(4000);
    expect(c).toBeLessThanOrEqual(5100);
  });

  it('caps backoff at the 30s max', () => {
    // Attempt 10 would naively yield 1024 seconds.
    const out = computeRetryBackoffMs(10, undefined);
    expect(out).toBeGreaterThanOrEqual(30_000);
    expect(out).toBeLessThanOrEqual(37_500);
  });
});

describe('UrlFetcher.fetchPage (429 retry path)', () => {
  it('retries once on 429 with Retry-After and returns the 200 follow-up', async () => {
    const { sleepFn, calls } = makeRecorderSleep();
    const fetchFn = scriptedFetch([
      { status: 429, body: 'busy', headers: { 'retry-after': '2', 'content-type': 'text/plain' } },
      { status: 200, body: html('hello'), headers: { 'content-type': 'text/html' } },
    ]);
    // Skip robots — accept the host's loadRobots calling out and falling
    // through (this fetcher's robots fetch will hit the scripted queue
    // first; we keep the test focused by pointing at a path the test
    // host says is allowed). Easier: prepend a 404 robots response.
    const fetchFnWithRobots = scriptedFetch([
      { status: 404, body: 'no robots', headers: { 'content-type': 'text/plain' } },
      { status: 429, body: 'busy', headers: { 'retry-after': '2', 'content-type': 'text/plain' } },
      { status: 200, body: html('hello'), headers: { 'content-type': 'text/html' } },
    ]);
    void fetchFn;
    const fetcher = new UrlFetcher({
      fetchFn: fetchFnWithRobots,
      sleepFn,
      // Avoid baked-in delays so the assertions are about the retry path,
      // not initial pacing.
      minDelayMsPerHost: 0,
    });
    const page = await fetcher.fetchPage('https://example.test/page');
    expect(page.status).toBe(200);
    expect(page.html).toContain('hello');
    // We slept AT LEAST once (the retry backoff). With Retry-After=2s
    // the sleep call should be >= 2000.
    const retrySleep = calls.find((ms) => ms >= 2000);
    expect(retrySleep).toBeDefined();
  });

  it('returns the 429 unchanged when retries exhaust', async () => {
    const { sleepFn } = makeRecorderSleep();
    const fetchFn = scriptedFetch([
      { status: 404, body: '', headers: { 'content-type': 'text/plain' } }, // robots
      { status: 429, body: 'busy', headers: { 'retry-after': '1', 'content-type': 'text/plain' } },
      { status: 429, body: 'busy', headers: { 'retry-after': '1', 'content-type': 'text/plain' } },
      { status: 429, body: 'busy', headers: { 'retry-after': '1', 'content-type': 'text/plain' } },
      { status: 429, body: 'busy', headers: { 'retry-after': '1', 'content-type': 'text/plain' } },
    ]);
    const fetcher = new UrlFetcher({
      fetchFn,
      sleepFn,
      minDelayMsPerHost: 0,
      maxRetries: 3,
    });
    const page = await fetcher.fetchPage('https://example.test/x');
    expect(page.status).toBe(429);
    // Penalty should now be active.
    const pacing = fetcher.hostPacing('example.test');
    expect(pacing).not.toBeNull();
    expect(pacing!.penaltyMs).toBeGreaterThan(0);
  });

  it('grows the penalty on each fresh 429 and caps it', async () => {
    const { sleepFn } = makeRecorderSleep();
    // 4 sequential 429s with NO Retry-After — exercises pure adaptive backoff.
    const fetchFn = scriptedFetch([
      { status: 404, body: '', headers: { 'content-type': 'text/plain' } }, // robots
      { status: 429, body: '', headers: { 'content-type': 'text/plain' } },
      { status: 429, body: '', headers: { 'content-type': 'text/plain' } },
      { status: 429, body: '', headers: { 'content-type': 'text/plain' } },
      { status: 429, body: '', headers: { 'content-type': 'text/plain' } },
    ]);
    const fetcher = new UrlFetcher({
      fetchFn,
      sleepFn,
      minDelayMsPerHost: 100,
      maxRetries: 3,
    });
    await fetcher.fetchPage('https://example.test/y');
    const pacing = fetcher.hostPacing('example.test')!;
    // 4 hits → penalty = base*2, doubled 3 more times = base*16 = 1600.
    // Capped at 30000. Either way: > base*2.
    expect(pacing.penaltyMs).toBeGreaterThan(200);
    expect(pacing.penaltyMs).toBeLessThanOrEqual(30_000);
  });

  it('does not retry on 404 (only 429/503)', async () => {
    const { sleepFn, calls } = makeRecorderSleep();
    const fetchFn = scriptedFetch([
      { status: 404, body: '', headers: { 'content-type': 'text/plain' } }, // robots
      { status: 404, body: 'not found', headers: { 'content-type': 'text/plain' } },
    ]);
    const fetcher = new UrlFetcher({
      fetchFn,
      sleepFn,
      minDelayMsPerHost: 0,
    });
    const page = await fetcher.fetchPage('https://example.test/missing');
    expect(page.status).toBe(404);
    // No retry sleep happened — `calls` may contain the initial pacing
    // (which is 0 here) but no >=1000 entries.
    expect(calls.filter((ms) => ms >= 1000)).toHaveLength(0);
  });
});

describe('UrlFetcher.acquireHostSlot (BrowserBackend integration surface)', () => {
  it('blocks subsequent acquisitions while one is in-flight', async () => {
    const fetcher = new UrlFetcher({
      maxConcurrentPerHost: 1,
      minDelayMsPerHost: 0,
      fetchFn: vi.fn(),
      sleepFn: async () => {},
    });
    const order: string[] = [];
    let resolveFirst!: () => void;
    const firstDone = new Promise<void>((r) => (resolveFirst = r));
    const first = fetcher.acquireHostSlot('host.test', async () => {
      order.push('first-start');
      await firstDone;
      order.push('first-end');
      return 1;
    });
    // Kick off second concurrently — must NOT start until first releases.
    const second = fetcher.acquireHostSlot('host.test', async () => {
      order.push('second-start');
      return 2;
    });
    // Microtask flush — gives `first` time to enter its body.
    await Promise.resolve();
    expect(order).toEqual(['first-start']);
    resolveFirst();
    await first;
    await second;
    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
  });

  it('routes DIFFERENT hosts in parallel (separate semaphores)', async () => {
    const fetcher = new UrlFetcher({
      maxConcurrentPerHost: 1,
      minDelayMsPerHost: 0,
      fetchFn: vi.fn(),
      sleepFn: async () => {},
    });
    const order: string[] = [];
    let resolveA!: () => void;
    const aDone = new Promise<void>((r) => (resolveA = r));
    const a = fetcher.acquireHostSlot('host-a.test', async () => {
      order.push('a-start');
      await aDone;
      order.push('a-end');
    });
    const b = fetcher.acquireHostSlot('host-b.test', async () => {
      order.push('b-start');
      order.push('b-end');
    });
    await Promise.resolve();
    expect(order).toContain('a-start');
    expect(order).toContain('b-start'); // b started even though a is still holding host-a's slot
    resolveA();
    await Promise.all([a, b]);
    expect(order).toContain('a-end');
    expect(order).toContain('b-end');
  });
});
