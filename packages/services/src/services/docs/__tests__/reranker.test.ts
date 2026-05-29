/**
 * Coverage for Reranker — LLM-driven re-ordering of doc-search top-K.
 *
 * Invariants:
 *   - reranked=false on every degraded path (no binding, LLM error,
 *     unparseable response, candidates.length <= 1).
 *   - When reranked, candidates come back in score-descending order.
 *   - Cache hit returns reranked=true, cacheHit=true, no LLM call.
 *   - Telemetry emitted with stage='rerank'.
 *   - dropped reflects candidates filtered by scoreCutoff.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { Reranker } from '../reranker.js';
import type { RerankCandidate } from '../reranker.js';
import type {
  PipelineProviderResolver,
  ResolvedBinding,
} from '../../../pipelines/index.js';
import type { PipelineTelemetryStore } from '@mcp/store/pipeline-telemetry-store.js';

function makeBinding(): ResolvedBinding {
  return {
    pipelineName: 'doc_search',
    bindingRole: 'reranker',
    provider: { id: 'p1', kind: 'cloudflare', enabled: true } as unknown as ResolvedBinding['provider'],
    modelId: 'fake-reranker',
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

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE doc_rerank_cache (
      query_hash            TEXT NOT NULL,
      candidates_hash       TEXT NOT NULL,
      model_id              TEXT NOT NULL,
      reranked_order_json   TEXT NOT NULL,
      created_at            TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (query_hash, candidates_hash, model_id)
    );
    CREATE INDEX idx_doc_rerank_cache_created ON doc_rerank_cache(created_at);
  `);
  return db;
}

function makeCandidates(): RerankCandidate[] {
  return [
    {
      chunk_id: 101,
      heading_path: 'Guide > Auth > OAuth',
      snippet: 'OAuth 2.0 setup with NextAuth.js. The recommended approach...',
      pre_rerank_score: 0.7,
      concepts: ['oauth', 'nextauth'],
    },
    {
      chunk_id: 202,
      heading_path: 'Guide > Routing > Middleware',
      snippet: 'Middleware runs before route resolution. Use it for auth...',
      pre_rerank_score: 0.6,
      concepts: ['middleware', 'auth'],
    },
    {
      chunk_id: 303,
      heading_path: 'API > Cookies',
      snippet: 'cookies() returns a ReadonlyRequestCookies instance.',
      pre_rerank_score: 0.5,
    },
  ];
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

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Reranker', () => {
  it('returns candidates unchanged when no binding is configured', async () => {
    const reranker = new Reranker({ resolver: resolverWith(null) });
    const candidates = makeCandidates();
    const result = await reranker.rerank('how to use OAuth in Next.js', candidates);
    expect(result.reranked).toBe(false);
    expect(result.cacheHit).toBe(false);
    expect(result.candidates).toEqual(candidates);
    expect(result.modelId).toBeNull();
  });

  it('returns candidates unchanged with skipLlm', async () => {
    const reranker = new Reranker({
      resolver: resolverWith(makeBinding()),
      skipLlm: true,
    });
    const candidates = makeCandidates();
    const result = await reranker.rerank('q', candidates);
    expect(result.reranked).toBe(false);
    expect(result.candidates).toEqual(candidates);
  });

  it('returns single candidate unchanged (nothing to reorder)', async () => {
    const reranker = new Reranker({ resolver: resolverWith(makeBinding()) });
    const candidates = [makeCandidates()[0]!];
    const result = await reranker.rerank('q', candidates);
    expect(result.reranked).toBe(false);
    expect(result.candidates).toEqual(candidates);
  });

  it('reorders candidates by LLM scores (descending)', async () => {
    // Original order: 101, 202, 303 — scores 0.3, 0.95, 0.5 should re-rank to 202, 303, 101.
    stubFetchOk('[0.3, 0.95, 0.5]');
    const reranker = new Reranker({
      resolver: resolverWith(makeBinding()),
    });
    const candidates = makeCandidates();
    const result = await reranker.rerank('how to use OAuth in Next.js', candidates);
    expect(result.reranked).toBe(true);
    expect(result.candidates.map((c) => c.chunk_id)).toEqual([202, 303, 101]);
    expect(result.modelId).toBe('fake-reranker');
  });

  it('exposes the calibrated 0-1 score per chunk_id', async () => {
    stubFetchOk('[0.3, 0.95, 0.5]');
    const reranker = new Reranker({ resolver: resolverWith(makeBinding()) });
    const result = await reranker.rerank('q', makeCandidates());
    expect(result.scoreByChunkId).toBeInstanceOf(Map);
    expect(result.scoreByChunkId?.get(101)).toBeCloseTo(0.3);
    expect(result.scoreByChunkId?.get(202)).toBeCloseTo(0.95);
    expect(result.scoreByChunkId?.get(303)).toBeCloseTo(0.5);
  });

  it('leaves scoreByChunkId undefined on degraded paths', async () => {
    const reranker = new Reranker({ resolver: resolverWith(null) });
    const result = await reranker.rerank('q', makeCandidates());
    expect(result.reranked).toBe(false);
    expect(result.scoreByChunkId).toBeUndefined();
  });

  it('falls back to original order on unparseable LLM response', async () => {
    stubFetchOk('not json at all');
    const reranker = new Reranker({ resolver: resolverWith(makeBinding()) });
    const candidates = makeCandidates();
    const result = await reranker.rerank('q', candidates);
    expect(result.reranked).toBe(false);
    expect(result.candidates.map((c) => c.chunk_id)).toEqual([101, 202, 303]);
  });

  it('drops candidates below the scoreCutoff and reports dropped count', async () => {
    stubFetchOk('[0.1, 0.95, 0.5]');
    const reranker = new Reranker({ resolver: resolverWith(makeBinding()) });
    const candidates = makeCandidates();
    const result = await reranker.rerank('q', candidates, { scoreCutoff: 0.4 });
    expect(result.reranked).toBe(true);
    expect(result.dropped).toBe(1); // 101 dropped (score 0.1)
    expect(result.candidates.map((c) => c.chunk_id)).toEqual([202, 303]);
  });

  it('caches verdicts and short-circuits on the next call', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '[0.3, 0.95, 0.5]' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const db = makeDb();
    const reranker = new Reranker({
      resolver: resolverWith(makeBinding()),
      db,
    });
    const candidates = makeCandidates();

    const first = await reranker.rerank('q', candidates);
    expect(first.cacheHit).toBe(false);
    expect(first.reranked).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const second = await reranker.rerank('q', candidates);
    expect(second.cacheHit).toBe(true);
    expect(second.reranked).toBe(true);
    expect(second.candidates.map((c) => c.chunk_id)).toEqual(first.candidates.map((c) => c.chunk_id));
    expect(fetchMock).toHaveBeenCalledTimes(1); // no second LLM call
    // Calibrated scores survive the cache round-trip.
    expect(second.scoreByChunkId?.get(202)).toBeCloseTo(0.95);

    db.close();
  });

  it('emits telemetry with stage=rerank', async () => {
    stubFetchOk('[0.5, 0.6, 0.7]');
    const telemetry = makeTelemetry();
    const reranker = new Reranker({
      resolver: resolverWith(makeBinding()),
      telemetry,
    });
    await reranker.rerank('q', makeCandidates());
    expect(telemetry.rows.length).toBe(1);
    const row = telemetry.rows[0] as { stage: string; candidates_in: number; candidates_out: number };
    expect(row.stage).toBe('rerank');
    expect(row.candidates_in).toBe(3);
    expect(row.candidates_out).toBe(3);
  });

  it('pruneStaleCache removes rows older than the cutoff', () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO doc_rerank_cache (query_hash, candidates_hash, model_id, reranked_order_json, created_at)
       VALUES (?, ?, ?, ?, datetime('now', '-2 days'))`,
    ).run('old', 'old', 'm', '[]');
    db.prepare(
      `INSERT INTO doc_rerank_cache (query_hash, candidates_hash, model_id, reranked_order_json)
       VALUES (?, ?, ?, ?)`,
    ).run('new', 'new', 'm', '[]');

    const pruned = Reranker.pruneStaleCache(db, 24);
    expect(pruned).toBe(1);
    const remaining = db.prepare('SELECT COUNT(*) as c FROM doc_rerank_cache').get() as { c: number };
    expect(remaining.c).toBe(1);
    db.close();
  });
});
