/**
 * Coverage for the CloudflareEmbeddingService — specifically the context-
 * overflow split-and-retry path added after hitting "Max context reached
 * 67200 tokens but model supports only 60000" in production logs.
 *
 * The estimator (`length / 4`) underestimates by 30-50% on technical
 * docs; the maxBatchTokens cap is conservative (35k vs 60k API limit)
 * but doesn't fully eliminate the case. `embedBatch` is the second line
 * of defense: it halves the batch and retries when the API rejects with
 * the canonical 3030 error.
 */
import { describe, it, expect, vi } from 'vitest';
import { CloudflareEmbeddingService, OpenAICompatEmbeddingService } from '../embeddings.js';

type FetchResp = { status: number; body: unknown };
type FetchCall = { url: string; body: string[] };

/**
 * Build a stubbed `fetch` that responds with a sequence of canned
 * responses (one per call) and records every received batch. The
 * payload `body` is parsed as JSON `{ texts: string[] }` so assertions
 * can inspect the actual batch splits.
 */
function stubFetch(responses: FetchResp[]) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const idx = calls.length;
    const resp = responses[idx];
    if (!resp) throw new Error(`unexpected fetch call #${idx + 1}`);
    const parsed = init?.body ? JSON.parse(String(init.body)) as { texts?: string[] } : {};
    calls.push({ url: String(url), body: parsed.texts ?? [] });
    return new Response(typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body), {
      status: resp.status,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

function okVectors(count: number, dim: number = 3): { vectors: number[][]; count: number } {
  return {
    vectors: Array.from({ length: count }, (_, i) => Array.from({ length: dim }, () => i + 1)),
    count,
  };
}

const CONTEXT_OVERFLOW_BODY = '{"error":"3030: Max context reached 67200 tokens but model supports only 60000"}';

describe('CloudflareEmbeddingService — context overflow split + retry', () => {
  it('splits a 4-text batch in half when the API returns 3030, then resplits the failing half', async () => {
    // Sequence:
    //   call 1: [a,b,c,d]   → 500 context overflow
    //   call 2: [a,b]       → 500 context overflow (left half still too big)
    //   call 3: [a]         → ok (single text — recursion floor)
    //   call 4: [b]         → ok
    //   call 5: [c,d]       → ok (right half fits)
    const { fetch, calls } = stubFetch([
      { status: 500, body: CONTEXT_OVERFLOW_BODY },
      { status: 500, body: CONTEXT_OVERFLOW_BODY },
      { status: 200, body: okVectors(1) },
      { status: 200, body: okVectors(1) },
      { status: 200, body: okVectors(2) },
    ]);
    const svc = new CloudflareEmbeddingService('https://worker.test', 'tok', fetch);

    const result = await svc.embed(['a', 'b', 'c', 'd']);

    expect(result.vectors.length).toBe(4);
    expect(calls.length).toBe(5);
    expect(calls.map((c) => c.body)).toEqual([
      ['a', 'b', 'c', 'd'],
      ['a', 'b'],
      ['a'],
      ['b'],
      ['c', 'd'],
    ]);
  });

  it('does NOT retry context overflow on a single-text batch (recursion floor → propagate)', async () => {
    const { fetch, calls } = stubFetch([
      { status: 500, body: CONTEXT_OVERFLOW_BODY },
    ]);
    const svc = new CloudflareEmbeddingService('https://worker.test', 'tok', fetch);

    await expect(svc.embed(['solo'])).rejects.toThrow(/Max context reached/);
    expect(calls.length).toBe(1); // one attempt, no retry of identical solo batch
  });

  it('does NOT retry context overflow with exponential backoff (deterministic, would burn time)', async () => {
    // The legacy fetchWithRetry retried any 5xx 3 times. For context
    // overflow we short-circuit and let embedBatch handle the split.
    const { fetch, calls } = stubFetch([
      { status: 500, body: CONTEXT_OVERFLOW_BODY },
      { status: 200, body: okVectors(1) },
    ]);
    const svc = new CloudflareEmbeddingService('https://worker.test', 'tok', fetch);

    await expect(svc.embed(['onlyone'])).rejects.toThrow();
    expect(calls.length).toBe(1); // no fetchWithRetry-style retries
  });

  it('still retries on generic 5xx (non-context) errors', async () => {
    const { fetch, calls } = stubFetch([
      { status: 503, body: '{"error":"service unavailable"}' },
      { status: 200, body: okVectors(1) },
    ]);
    const svc = new CloudflareEmbeddingService('https://worker.test', 'tok', fetch);

    const result = await svc.embed(['x']);
    expect(result.vectors.length).toBe(1);
    expect(calls.length).toBe(2);
  });

  it('throws cleanly on 4xx without retry (not server-transient)', async () => {
    const { fetch, calls } = stubFetch([
      { status: 401, body: '{"error":"bad token"}' },
    ]);
    const svc = new CloudflareEmbeddingService('https://worker.test', 'tok', fetch);

    await expect(svc.embed(['x'])).rejects.toThrow(/401/);
    expect(calls.length).toBe(1);
  });
});

describe('CloudflareEmbeddingService — fetch timeout (AbortController)', () => {
  /**
   * Build a fetch stub that hangs the first N calls (resolves only after
   * AbortError fires from the AbortController), then returns the canned
   * response for subsequent calls. Lets us verify retry+timeout behavior
   * without burning real wall-clock time.
   */
  function hangingFetch(opts: { hangCount: number; thenRespond?: FetchResp }) {
    const calls: Array<{ aborted: boolean; elapsed: number }> = [];
    let calledTimes = 0;
    const fn = vi.fn(async (_url: string | URL, init?: RequestInit): Promise<Response> => {
      const startedAt = Date.now();
      const myCall = calledTimes++;
      if (myCall < opts.hangCount) {
        // Wait for the AbortSignal. Reject with AbortError when it fires.
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          if (!signal) {
            reject(new Error('test setup: no AbortSignal passed'));
            return;
          }
          signal.addEventListener('abort', () => {
            calls.push({ aborted: true, elapsed: Date.now() - startedAt });
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }
      calls.push({ aborted: false, elapsed: Date.now() - startedAt });
      const resp = opts.thenRespond ?? { status: 200, body: okVectors(1) };
      return new Response(typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body), {
        status: resp.status,
        headers: { 'content-type': 'application/json' },
      });
    });
    return { fetch: fn as unknown as typeof fetch, calls };
  }

  it('aborts a hanging request after requestTimeoutMs and surfaces a timeout error', async () => {
    const { fetch, calls } = hangingFetch({ hangCount: 999 }); // always hangs
    // 50ms timeout so the test runs fast; ALL 4 attempts will time out.
    const svc = new CloudflareEmbeddingService('https://worker.test', 'tok', fetch, 50);

    await expect(svc.embed(['x'])).rejects.toThrow(/Embedding API timeout|aborted/i);
    // 1 initial + 3 retries = 4 calls, all aborted
    expect(calls.length).toBe(4);
    expect(calls.every((c) => c.aborted)).toBe(true);
    expect(calls.every((c) => c.elapsed >= 45 && c.elapsed < 250)).toBe(true);
  });

  it('retries up to 3 times on abort, then succeeds when the host recovers', async () => {
    const { fetch, calls } = hangingFetch({
      hangCount: 2,                                          // first 2 hang
      thenRespond: { status: 200, body: okVectors(1) },      // 3rd succeeds
    });
    const svc = new CloudflareEmbeddingService('https://worker.test', 'tok', fetch, 50);

    const result = await svc.embed(['x']);

    expect(result.vectors.length).toBe(1);
    expect(calls.length).toBe(3);
    expect(calls[0].aborted).toBe(true);
    expect(calls[1].aborted).toBe(true);
    expect(calls[2].aborted).toBe(false);
  });

  it('does not arm the timer when the response comes back fast', async () => {
    const { fetch, calls } = stubFetch([{ status: 200, body: okVectors(1) }]);
    const svc = new CloudflareEmbeddingService('https://worker.test', 'tok', fetch, 50);
    const result = await svc.embed(['x']);
    expect(result.vectors.length).toBe(1);
    expect(calls.length).toBe(1);
  });
});

describe('OpenAICompatEmbeddingService — provider-backed embeddings', () => {
  it('POSTs to {baseURL}/embeddings with the model and verbatim input (no e5 prefixes)', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchFn = (async (url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body) as { input: string[] };
      calls.push({ url: String(url), body: body as unknown as Record<string, unknown> });
      const data = body.input.map((_t, i) => ({ index: i, embedding: [i, i, i] }));
      return new Response(JSON.stringify({ data }), { status: 200 });
    }) as unknown as typeof fetch;
    const svc = new OpenAICompatEmbeddingService({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: 'k',
      model: 'openai/text-embedding-3-large',
      fetchFn,
    });

    const r = await svc.embed(['query text', 'passage text']);

    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/embeddings');
    expect(calls[0].body.model).toBe('openai/text-embedding-3-large');
    // Verbatim — no `query:`/`passage:` prefixes (those are e5-only).
    expect(calls[0].body.input).toEqual(['query text', 'passage text']);
    expect(calls[0].body.dimensions).toBeUndefined();
    expect(r.vectors).toEqual([[0, 0, 0], [1, 1, 1]]);
  });

  it('forwards dimensions and encodes them in the fingerprint', async () => {
    let captured: Record<string, unknown> = {};
    const fetchFn = (async (_url: unknown, init: { body: string }) => {
      captured = JSON.parse(init.body) as Record<string, unknown>;
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const svc = new OpenAICompatEmbeddingService({
      baseURL: 'https://x/v1',
      apiKey: 'k',
      model: 'text-embedding-3-large',
      dimensions: 256,
      providerId: 'or',
      fetchFn,
    });

    await svc.embed(['a']);

    expect(captured.dimensions).toBe(256);
    expect(svc.fingerprint()).toBe('provider:or:text-embedding-3-large:256');
  });

  it('fingerprint omits the dimensions suffix when unset', () => {
    const svc = new OpenAICompatEmbeddingService({
      baseURL: 'https://x/v1',
      apiKey: 'k',
      model: 'm',
      providerId: 'or',
    });
    expect(svc.fingerprint()).toBe('provider:or:m');
  });

  it('sorts returned rows by index so vectors align with their input text', async () => {
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({ data: [{ index: 1, embedding: [9] }, { index: 0, embedding: [8] }] }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const svc = new OpenAICompatEmbeddingService({
      baseURL: 'https://x/v1',
      apiKey: 'k',
      model: 'm',
      fetchFn,
    });

    const r = await svc.embed(['a', 'b']);
    expect(r.vectors).toEqual([[8], [9]]);
  });

  it('throws cleanly on a non-2xx response (surfaces status)', async () => {
    const fetchFn = (async () =>
      new Response('{"error":"bad key"}', { status: 401 })) as unknown as typeof fetch;
    const svc = new OpenAICompatEmbeddingService({
      baseURL: 'https://x/v1',
      apiKey: 'k',
      model: 'm',
      fetchFn,
    });

    await expect(svc.embed(['a'])).rejects.toThrow(/401/);
  });
});

describe('CloudflareEmbeddingService — batching cap', () => {
  it('respects the 35k token soft cap (estimator length/4) and splits proactively', async () => {
    // Each text: 30000 chars = 7500 estimated tokens (under the 8192
    // per-text truncation cap, so the texts pass through unchanged).
    // 5 texts → 37500 total estimated tokens.
    //
    // With the new 35k batch cap:
    //   batch 1: 4 texts × 7500 = 30000 tokens (fits)
    //   batch 2: 1 text × 7500 = 7500 tokens (overflow of batch 1)
    //
    // With the OLD 50k cap, this would have been a single batch — so
    // the test fails closed if someone bumps the cap back up.
    const big = 'a'.repeat(30_000);
    const { fetch, calls } = stubFetch([
      { status: 200, body: okVectors(4) },
      { status: 200, body: okVectors(1) },
    ]);
    const svc = new CloudflareEmbeddingService('https://worker.test', 'tok', fetch);

    const result = await svc.embed([big, big, big, big, big]);
    expect(result.vectors.length).toBe(5);
    expect(calls.length).toBe(2);
    expect(calls[0].body.length).toBe(4);
    expect(calls[1].body.length).toBe(1);
  });
});
