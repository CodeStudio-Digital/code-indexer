/**
 * Coverage for `extractLinksWithLLM` — the seed-only link extractor
 * that recovers URLs cheerio misses on sites where navigation lives in
 * data-attributes, embedded JSON, or script bodies (Addendum 4).
 *
 * Graceful degradation is the primary invariant: no binding → empty
 * array, LLM error → empty array, unparseable response → empty array.
 * The crawler must keep moving on cheerio links alone when this fails.
 */
import { describe, it, expect, vi } from 'vitest';
import { extractLinksWithLLM } from '../link-extractor.js';
import type { PipelineProviderResolver, ResolvedBinding } from '../../../pipelines/index.js';

interface ChatResponse { content: string; errorBody?: string; latencyMs?: number }

function makeBinding(): ResolvedBinding {
  return {
    pipelineName: 'doc_ingest',
    bindingRole: 'link_extractor',
    provider: { id: 'p1', kind: 'cloudflare', enabled: true } as unknown as ResolvedBinding['provider'],
    modelId: 'fake-model',
    modelMode: '',
    config: {},
    resolvedFrom: 'global',
    bindingId: 1,
  };
}

function resolverWith(binding: ResolvedBinding | null, chatResp: ChatResponse | Error): PipelineProviderResolver {
  const resolveOrNull = vi.fn(async () => binding);
  // The link-extractor uses pickChatFn(binding) — we patch the global
  // chat dispatcher per-call by stubbing fetch... but simpler: we
  // pickChatFn returns a function that hits Cloudflare. Tests
  // intercept by replacing `fetchFn` would require deeper plumbing.
  // Instead we override the resolver's `resolve` to return a binding
  // whose provider triggers `openAiCompatibleChat`, then stub global
  // `fetch`. To keep tests self-contained, we monkey-patch the chat
  // dispatcher via the `pickChatFn` import — see beforeEach below.
  return {
    resolveOrNull,
    resolve: vi.fn(),
  } as unknown as PipelineProviderResolver;
}

// We avoid the real chat dispatcher by stubbing global fetch with a
// canned response shaped like the openai-compatible chat endpoint.
function stubGlobalFetchWithChatResponse(content: string, status = 200) {
  const fn = vi.fn(async (_url: string | URL, _init?: RequestInit): Promise<Response> => {
    const body = status === 200
      ? JSON.stringify({ choices: [{ message: { content } }] })
      : `{"error":"${content}"}`;
    return new Response(body, {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('extractLinksWithLLM', () => {
  it('returns [] when no binding configured (silent fallback)', async () => {
    const resolver = resolverWith(null, { content: '' });
    const result = await extractLinksWithLLM('https://example.com/seed', '<html></html>', { resolver });
    expect(result).toEqual([]);
  });

  it('parses a valid JSON response and resolves relative URLs', async () => {
    stubGlobalFetchWithChatResponse(
      '[{"url":"/api/Camera.html","reason":"data-href in sidebar"},{"url":"/api/Rigidbody.html","reason":"__NEXT_DATA__"}]',
    );
    const resolver = resolverWith(makeBinding(), { content: '' });

    const result = await extractLinksWithLLM(
      'https://docs.example.com/index.html',
      '<html><script>window.__NEXT_DATA__={"page":"/api/Camera.html"}</script></html>',
      { resolver },
    );

    expect(result.length).toBe(2);
    expect(result[0].url).toBe('https://docs.example.com/api/Camera.html');
    expect(result[1].url).toBe('https://docs.example.com/api/Rigidbody.html');
    expect(result[0].reason).toContain('data-href');
    vi.unstubAllGlobals();
  });

  it('drops mailto:, javascript:, tel:, and fragments', async () => {
    stubGlobalFetchWithChatResponse(
      '[' +
      '{"url":"mailto:x@y.z","reason":"a"},' +
      '{"url":"javascript:foo()","reason":"a"},' +
      '{"url":"tel:+555","reason":"a"},' +
      '{"url":"#section","reason":"a"},' +
      '{"url":"/api/Real.html","reason":"a"}' +
      ']',
    );
    const resolver = resolverWith(makeBinding(), { content: '' });

    const result = await extractLinksWithLLM('https://x.example.com/', '<html></html>', { resolver });

    expect(result.length).toBe(1);
    expect(result[0].url).toBe('https://x.example.com/api/Real.html');
    vi.unstubAllGlobals();
  });

  it('strips fragments from valid URLs', async () => {
    stubGlobalFetchWithChatResponse('[{"url":"/api/Camera.html#methods","reason":"a"}]');
    const resolver = resolverWith(makeBinding(), { content: '' });

    const result = await extractLinksWithLLM('https://x.example/', '<html></html>', { resolver });
    expect(result[0].url).toBe('https://x.example/api/Camera.html');
    vi.unstubAllGlobals();
  });

  it('returns [] for unparseable JSON response (no throw)', async () => {
    stubGlobalFetchWithChatResponse('not even close to JSON');
    const resolver = resolverWith(makeBinding(), { content: '' });

    const result = await extractLinksWithLLM('https://x.example/', '<html></html>', { resolver });
    expect(result).toEqual([]);
    vi.unstubAllGlobals();
  });

  it('returns [] when LLM endpoint returns non-2xx', async () => {
    stubGlobalFetchWithChatResponse('rate limited', 429);
    const resolver = resolverWith(makeBinding(), { content: '' });

    const result = await extractLinksWithLLM('https://x.example/', '<html></html>', { resolver });
    expect(result).toEqual([]);
    vi.unstubAllGlobals();
  });

  it('handles markdown-fenced JSON output (some models wrap in ```json)', async () => {
    stubGlobalFetchWithChatResponse(
      '```json\n[{"url":"/a.html","reason":"x"}]\n```',
    );
    const resolver = resolverWith(makeBinding(), { content: '' });

    const result = await extractLinksWithLLM('https://x.example/', '<html></html>', { resolver });
    expect(result.length).toBe(1);
    expect(result[0].url).toBe('https://x.example/a.html');
    vi.unstubAllGlobals();
  });

  it('caps at 200 entries even when LLM returns more', async () => {
    const items = Array.from({ length: 300 }, (_, i) => `{"url":"/page${i}.html","reason":"x"}`).join(',');
    stubGlobalFetchWithChatResponse(`[${items}]`);
    const resolver = resolverWith(makeBinding(), { content: '' });

    const result = await extractLinksWithLLM('https://x.example/', '<html></html>', { resolver });
    expect(result.length).toBe(200);
    vi.unstubAllGlobals();
  });
});
