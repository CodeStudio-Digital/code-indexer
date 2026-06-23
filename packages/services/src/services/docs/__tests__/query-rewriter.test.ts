/**
 * Coverage for QueryRewriter — produces query variants for the
 * hybrid-search pipeline.
 *
 * Invariants:
 *   - variants[0] is ALWAYS the original query (graceful degradation
 *     guarantees the caller can always fall back to a single search).
 *   - No binding configured → returns [original] without an LLM call.
 *   - LLM error/timeout → returns [original].
 *   - Cache hit short-circuits the LLM call.
 *   - Telemetry is emitted with stage='query_rewrite' and the correct
 *     candidates_in/out counts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryRewriter } from '../query-rewriter.js';
import type {
  PipelineProviderResolver,
  ResolvedBinding,
} from '../../../pipelines/index.js';
import type { SubAgentResultCacheStore } from '@mcp/store/sub-agent-result-cache-store.js';
import type { PipelineTelemetryStore } from '@mcp/store/pipeline-telemetry-store.js';

function makeBinding(): ResolvedBinding {
  return {
    pipelineName: 'doc_search',
    bindingRole: 'rewriter',
    provider: { id: 'p1', kind: 'cloudflare', enabled: true } as unknown as ResolvedBinding['provider'],
    modelId: 'fake-model',
    modelMode: '',
    config: {},
    resolvedFrom: 'global',
    bindingId: 1,
  };
}

function resolverWith(binding: ResolvedBinding | null): PipelineProviderResolver {
  return {
    resolveOrNull: vi.fn(async () => binding),
    resolve: vi.fn(),
  } as unknown as PipelineProviderResolver;
}

function makeCache(): SubAgentResultCacheStore {
  const store = new Map<string, string>();
  return {
    lookup: vi.fn((opts: { prompt_hash: string; context_digest: string; agent_type: string }) => {
      const key = `${opts.prompt_hash}:${opts.context_digest}:${opts.agent_type}`;
      const v = store.get(key);
      return v
        ? {
            id: 1,
            session_id: null,
            prompt_hash: opts.prompt_hash,
            context_digest: opts.context_digest,
            agent_type: opts.agent_type,
            result_json: v,
            hit_count: 1,
            ttl_seconds: 86400,
            created_at: new Date().toISOString(),
            last_used_at: new Date().toISOString(),
          }
        : null;
    }),
    upsert: vi.fn((input: {
      prompt_hash: string;
      context_digest: string;
      agent_type: string;
      result_json: string;
    }) => {
      const key = `${input.prompt_hash}:${input.context_digest}:${input.agent_type}`;
      store.set(key, input.result_json);
      return 1;
    }),
  } as unknown as SubAgentResultCacheStore;
}

function makeTelemetry(): PipelineTelemetryStore & { rows: unknown[] } {
  const rows: unknown[] = [];
  return {
    rows,
    insert: vi.fn((row: unknown) => {
      rows.push(row);
      return rows.length;
    }),
  } as unknown as PipelineTelemetryStore & { rows: unknown[] };
}

function stubFetchOk(content: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

function stubFetchError() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      return new Response(JSON.stringify({ error: 'upstream timeout' }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('QueryRewriter', () => {
  it('returns [original] when no binding is configured', async () => {
    const rewriter = new QueryRewriter({ resolver: resolverWith(null) });
    const result = await rewriter.rewrite('OAuth Next.js 15');
    expect(result.variants).toEqual(['OAuth Next.js 15']);
    expect(result.llmUsed).toBe(false);
    expect(result.cacheHit).toBe(false);
    expect(result.modelId).toBeNull();
  });

  it('returns [original] when skipLlm is set', async () => {
    const rewriter = new QueryRewriter({ resolver: resolverWith(makeBinding()), skipLlm: true });
    const result = await rewriter.rewrite('React Suspense');
    expect(result.variants).toEqual(['React Suspense']);
    expect(result.llmUsed).toBe(false);
  });

  it('parses a valid JSON array and appends variants after the original', async () => {
    stubFetchOk('["NextAuth.js OAuth provider", "OAuth 2.0 authorization code flow Next.js"]');
    const telemetry = makeTelemetry();
    const rewriter = new QueryRewriter({
      resolver: resolverWith(makeBinding()),
      telemetry,
    });
    const result = await rewriter.rewrite('OAuth Next.js 15');
    expect(result.variants[0]).toBe('OAuth Next.js 15');
    expect(result.variants.length).toBe(3);
    expect(result.variants).toContain('NextAuth.js OAuth provider');
    expect(result.llmUsed).toBe(true);
    expect(result.modelId).toBe('fake-model');
    // Telemetry emitted.
    expect(telemetry.rows.length).toBe(1);
  });

  it('returns [original] when LLM responds with non-JSON garbage', async () => {
    stubFetchOk('this is not json');
    const rewriter = new QueryRewriter({ resolver: resolverWith(makeBinding()) });
    const result = await rewriter.rewrite('foo bar');
    expect(result.variants).toEqual(['foo bar']);
    // llmUsed is false because only 1 variant came back
    expect(result.llmUsed).toBe(false);
  });

  it('returns [original] when LLM call fails', async () => {
    stubFetchError();
    const rewriter = new QueryRewriter({ resolver: resolverWith(makeBinding()) });
    const result = await rewriter.rewrite('whatever');
    expect(result.variants).toEqual(['whatever']);
    expect(result.llmUsed).toBe(false);
  });

  it('dedupes variants case-insensitively', async () => {
    stubFetchOk('["OAuth", "oauth", "OAUTH"]');
    const rewriter = new QueryRewriter({
      resolver: resolverWith(makeBinding()),
    });
    const result = await rewriter.rewrite('OAuth');
    // Original is already 'OAuth' (matching case-insensitively); the
    // three duplicates from the LLM should all be filtered out.
    expect(result.variants.length).toBe(1);
    expect(result.variants[0]).toBe('OAuth');
  });

  it('caches successful results and serves them on the next call', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '["variant A","variant B"]' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const cache = makeCache();
    const rewriter = new QueryRewriter({
      resolver: resolverWith(makeBinding()),
      cache,
    });

    const first = await rewriter.rewrite('hello world');
    expect(first.cacheHit).toBe(false);
    expect(first.llmUsed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const second = await rewriter.rewrite('hello world');
    expect(second.cacheHit).toBe(true);
    expect(second.variants).toEqual(first.variants);
    // Second call MUST NOT hit the LLM.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('caps variants at maxVariants', async () => {
    stubFetchOk('["v1","v2","v3","v4","v5","v6"]');
    const rewriter = new QueryRewriter({ resolver: resolverWith(makeBinding()) });
    const result = await rewriter.rewrite('q', { maxVariants: 3 });
    expect(result.variants.length).toBe(3);
    expect(result.variants[0]).toBe('q'); // original always first
  });
});
