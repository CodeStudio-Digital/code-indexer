import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderStore } from '@mcp/store/provider-store.js';
import type { EmbeddingService } from '../embeddings.js';
import {
  NormalizedEmbeddingService,
  createEmbeddingServiceForTarget,
  createRerankerForTarget,
} from '../semantic-targets.js';
import { LocalReranker } from '../local-reranker.js';
import { LocalEmbeddingService } from '../local-embeddings.js';

const emptyProviders = {
  getProvider: () => null,
  getOAuth: () => null,
} as unknown as ProviderStore;

afterEach(() => vi.unstubAllGlobals());

describe('semantic targets', () => {
  it('pins ONNX dtype and protocol in the local embedding fingerprint', () => {
    const q8 = new LocalEmbeddingService({ model: 'test/model', dtype: 'q8' });
    const fp32 = new LocalEmbeddingService({ model: 'test/model', dtype: 'fp32' });
    expect(q8.fingerprint()).not.toBe(fp32.fingerprint());
    expect(q8.diagnostics()).toMatchObject({ dtype: 'q8', dimension: null, loaded: false });
  });

  it('normalizes document/query vectors and rejects dimension drift or non-finite values', async () => {
    let mode: 'normal' | 'dimension' | 'nan' = 'normal';
    const inner: EmbeddingService = {
      async embed(texts) {
        const vector = mode === 'dimension' ? [1, 0, 0] : mode === 'nan' ? [Number.NaN, 0] : [3, 4];
        return { vectors: texts.map(() => vector), tokens: texts.length };
      },
      async embedQuery() {
        const vector = mode === 'dimension' ? [1, 0, 0] : mode === 'nan' ? [Number.NaN, 0] : [6, 8];
        return { vector, tokens: 1 };
      },
      fingerprint: () => 'fake',
    };
    const service = new NormalizedEmbeddingService(inner);
    expect((await service.embed(['a'])).vectors[0]).toEqual([0.6, 0.8]);
    expect((await service.embedQuery('q')).vector).toEqual([0.6, 0.8]);
    mode = 'dimension';
    await expect(service.embedQuery('q')).rejects.toThrow(/dimension changed/);
    mode = 'nan';
    await expect(service.embed(['a'])).rejects.toThrow(/non-finite/);
  });

  it('rejects non-loopback local HTTP targets before making a request', () => {
    expect(() => createEmbeddingServiceForTarget({
      kind: 'local_http', baseUrl: 'https://example.com/v1', model: 'embed', protocol: 'openai-embeddings',
    }, emptyProviders)).toThrow(/localhost/);
    expect(() => createRerankerForTarget({
      kind: 'local_http', baseUrl: 'http://192.168.1.20:8080', model: 'rerank', protocol: 'cohere-rerank',
    }, emptyProviders)).toThrow(/localhost/);
  });

  it('allows loopback OpenAI/Cohere-compatible inference without an API key', () => {
    expect(createEmbeddingServiceForTarget({
      kind: 'local_http', baseUrl: 'http://127.0.0.1:11434/v1', model: 'embed', protocol: 'openai-embeddings',
    }, emptyProviders).fingerprint?.()).toContain('local-http');
    expect(createRerankerForTarget({
      kind: 'local_http', baseUrl: 'http://localhost:8080/v1', model: 'rerank', protocol: 'cohere-rerank',
    }, emptyProviders).name).toContain('local-http');
  });

  it('supports OpenAI-compatible rerank responses on loopback endpoints', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({ model: 'rerank', query: 'query', top_n: 2 });
      expect(body.documents).toEqual(['first', 'second']);
      return Response.json({ data: [
        { index: 1, score: 0.9 },
        { index: 0, score: 0.2 },
      ] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const reranker = createRerankerForTarget({
      kind: 'local_http', baseUrl: 'http://localhost:8080/v1',
      model: 'rerank', protocol: 'openai-rerank',
    }, emptyProviders);
    const results = await reranker.rerank('query', [
      { id: 'first', text: 'first', originalScore: 0.8 },
      { id: 'second', text: 'second', originalScore: 0.7 },
    ], 2);
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:8080/v1/rerank', expect.any(Object));
    expect(results.map((result) => result.id)).toEqual(['second', 'first']);
    expect(results.map((result) => result.score)).toEqual([0.9, 0.2]);
    expect(await reranker.diagnostics?.()).toMatchObject({
      configured: true,
      status: 'active',
      requested_model: 'rerank',
      invocation_count: 1,
      last_candidate_count: 2,
      last_returned_count: 2,
      last_error: null,
    });
  });

  it('keeps descending RRF order when the configured reranker fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('offline', { status: 503 })));
    const reranker = createRerankerForTarget({
      kind: 'local_http', baseUrl: 'http://127.0.0.1:8080/v1',
      model: 'rerank', protocol: 'cohere-rerank',
    }, emptyProviders);
    const results = await reranker.rerank('query', [
      { id: 'low', text: 'low', originalScore: 0.1 },
      { id: 'high', text: 'high', originalScore: 0.9 },
    ], 2);
    expect(results.map((result) => result.id)).toEqual(['high', 'low']);
    expect(results.map((result) => result.score)).toEqual([0.9, 0.1]);
    expect(await reranker.diagnostics?.()).toMatchObject({
      status: 'failed',
      invocation_count: 1,
      last_error: expect.stringContaining('503'),
    });
  });

  it('fails strict ONNX reranker probes instead of silently returning RRF', async () => {
    const reranker = new LocalReranker({ model: 'broken/model', strict: true });
    (reranker as unknown as { lease: { acquire: () => Promise<never> } }).lease = {
      acquire: async () => { throw new Error('incompatible ONNX model'); },
    };
    await expect(reranker.rerank('query', [
      { id: 'candidate', text: 'text', originalScore: 0.5 },
    ], 1)).rejects.toThrow('incompatible ONNX model');
  });

  it('falls back when a reranker returns duplicate candidate mappings', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [
      { index: 0, score: 0.99 },
      { index: 0, score: 0.98 },
    ] })));
    const reranker = createRerankerForTarget({
      kind: 'local_http', baseUrl: 'http://localhost:8080/v1',
      model: 'rerank', protocol: 'openai-rerank',
    }, emptyProviders);
    const results = await reranker.rerank('query', [
      { id: 'low', text: 'low', originalScore: 0.1 },
      { id: 'high', text: 'high', originalScore: 0.9 },
    ], 2);
    expect(results.map((result) => result.id)).toEqual(['high', 'low']);
  });

  it('rejects incomplete result sets in strict mode instead of calibrating missing candidates', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [
      { index: 0, score: 0.99 },
    ] })));
    const reranker = createRerankerForTarget({
      kind: 'local_http', baseUrl: 'http://localhost:8080/v1',
      model: 'rerank', protocol: 'openai-rerank',
    }, emptyProviders, { strict: true });
    await expect(reranker.rerank('query', [
      { id: 'first', text: 'first', originalScore: 0.8 },
      { id: 'second', text: 'second', originalScore: 0.7 },
    ], 2)).rejects.toThrow(/invalid result set/);
  });

  it('rejects duplicate candidate indices in strict mode', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [
      { index: 0, score: 0.99 },
      { index: 0, score: 0.98 },
    ] })));
    const reranker = createRerankerForTarget({
      kind: 'local_http', baseUrl: 'http://localhost:8080/v1',
      model: 'rerank', protocol: 'openai-rerank',
    }, emptyProviders, { strict: true });
    await expect(reranker.rerank('query', [
      { id: 'first', text: 'first', originalScore: 0.8 },
      { id: 'second', text: 'second', originalScore: 0.7 },
    ], 2)).rejects.toThrow(/invalid result set/);
  });

  it('resolves the managed Cloudflare base URL template before embedding', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer cf-token' });
      return Response.json({ data: [{ index: 0, embedding: [3, 4] }] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const providers = {
      getProvider: () => ({
        id: 'cloudflare', kind: 'cloudflare', enabled: true,
        base_url: 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1',
        api_key: 'cf-token', extra: { account_id: 'account-123' },
      }),
      getOAuth: () => null,
    } as unknown as ProviderStore;
    const service = createEmbeddingServiceForTarget({
      kind: 'provider', providerId: 'cloudflare', model: '@cf/baai/bge-m3', protocol: 'cloudflare',
    }, providers);
    expect((await service.embed(['document'])).vectors[0]).toEqual([0.6, 0.8]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/accounts/account-123/ai/v1/embeddings',
      expect.any(Object),
    );
  });

  it('rejects duplicate OpenAI embedding indices before vectors can be misaligned', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [
      { index: 0, embedding: [1, 0] },
      { index: 0, embedding: [0, 1] },
    ] })));
    const service = createEmbeddingServiceForTarget({
      kind: 'local_http', baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'embed', protocol: 'openai-embeddings',
    }, emptyProviders);
    await expect(service.embed(['first', 'second'])).rejects.toThrow(/duplicate vector indices/);
  });
});
