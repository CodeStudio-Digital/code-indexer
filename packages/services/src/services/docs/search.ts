/**
 * DocHybridSearch — the dual-mode (FTS5 + vector) retrieval layer behind the
 * `rag_search_docs` agent tool and the dashboard's search test panel.
 *
 * Why not reuse `@mcp/indexer/search/hybrid.ts`? That class is hard-coupled
 * to `project_id`/`project_name` and the `files+symbols` schema. Doc chunks
 * are global and keyed by `heading_path` instead. Forking gives us a clean
 * 200-line implementation with no compromise on either side.
 *
 * Shared with the indexer at the building-block level (NOT class level):
 *   - `EmbeddingService` interface from `@mcp/indexer/search/embeddings.ts`
 *   - `VectorStore` interface from `@mcp/store/vectors.ts`
 *   - `rrfMerge` + `RRF_DEFAULT_K` from `@mcp/candidate-pipeline`
 */
import {
  embedQueryForNamespace,
  type EmbeddingService,
} from '@mcp/indexer/search/embeddings.js';
import type { VectorStore } from '@mcp/store/vectors.js';
import { rrfMerge, RRF_DEFAULT_K } from '@mcp/candidate-pipeline';
import type { DocChunk, DocStore } from '@mcp/store/doc-store.js';
import type { ResolveContext } from '../../pipelines/index.js';
import type { QueryRewriter } from './query-rewriter.js';
import type { DocReranker, RerankCandidate } from './reranker.js';
import { applyThreshold, type RelevanceSource } from './relevance-policy.js';
import { docNamespace } from '@mcp/shared/vector-namespace.js';

const DEFAULT_MAX_RESULTS = 100;
const DEFAULT_MAX_RERANK_CANDIDATES = 500;
const DEFAULT_RERANK_MULTIPLIER = 4;

function positiveEnvInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export interface DocSearchEnhancements {
  /** Run query-rewriter and merge variants via RRF. Default false. */
  rewrite?: boolean;
  /** Run reranker on hybrid output before final truncate. Default false. */
  rerank?: boolean;
  /** Candidates to score before the final top-K. Default: `limit * 4`. */
  top_k_for_rerank?: number;
}

export interface DocSearchInput {
  signal?: AbortSignal;
  /** Natural-language query. */
  query: string;
  /** Optional: restrict to a single collection name. Wins over `collection_ids`. */
  collection?: string;
  /**
   * Optional: restrict to a subset of collection ids (project scoping,
   * migration 134). Ignored when `collection` is supplied. An empty array
   * is treated as "no filter" — callers express "project has no links" by
   * omitting the field, not by passing [].
   */
  collection_ids?: number[];
  /** Top-K cap. Default 5; operational ceiling defaults to 100 and is configurable. */
  limit?: number;
  /**
   * Drop results whose calibrated relevance is below this cutoff. Only
   * applied when rerank produced calibrated scores (see relevance-policy);
   * uncalibrated result sets pass through untouched. When everything is
   * below the cutoff, `diag.no_good_match` is set and `results` is empty.
   */
  min_relevance?: number;
  /** Force a particular mode (debugging). */
  mode?: 'hybrid' | 'fts' | 'vector';
  /**
   * Opt-in pipeline enhancements (query rewrite + rerank). Caller must
   * also have wired the corresponding services into the DocHybridSearch
   * constructor — otherwise the flags are no-ops and the diagnostics
   * report `rewrite_used=false / rerank_used=false`. Default OFF.
   */
  enhancements?: DocSearchEnhancements;
  /**
   * Optional binding-resolution context for the enhancement LLMs
   * (session_id / company_session_id / template_id). Forwarded to
   * the QueryRewriter and Reranker.
   */
  resolveContext?: ResolveContext;
}

export interface DocSearchResult {
  chunk_id: number;
  collection: string;
  source_id: number;
  source_uri: string | null;
  heading_path: string | null;
  /** Heading-level deep-link fragment — cite as `source_uri#anchor`. */
  anchor: string | null;
  /** API symbol (api_reference docs), e.g. `Rigidbody.AddForce`. */
  api_symbol: string | null;
  /** API signature (api_reference docs), e.g. `AddForce(Vector3, ForceMode)`. */
  api_signature: string | null;
  snippet: string;
  /** Exact source-body size before the search preview boundary. */
  snippet_source_chars: number;
  /** Source-body chars retained in the preview (excludes summary/ellipsis). */
  snippet_retained_chars: number;
  snippet_truncated: boolean;
  /** Raw fusion score (RRF reciprocal-rank). NOT comparable across queries. */
  score: number;
  /**
   * Calibrated 0-1 relevance, when available. Populated from the reranker;
   * null when rerank didn't run. Prefer this over `score` for any
   * confidence/threshold decision.
   */
  relevance: number | null;
  /** Where `relevance` came from: 'rerank' is calibrated, 'rrf'/'none' are not. */
  relevance_source: RelevanceSource;
  summary: string | null;
  concepts: string[];
}

export interface DocSearchDiagnostics {
  fts_hits: number;
  vector_hits: number;
  mode: 'hybrid' | 'fts' | 'vector';
  embedding_available: boolean;
  vector_available: boolean;
  /** Whether query-rewrite actually ran (false if disabled or no binding). */
  rewrite_used?: boolean;
  /** Number of query variants (including original) when rewrite ran. */
  rewrite_variants?: number;
  /** Whether reranker actually ran (false if disabled or no binding). */
  rerank_used?: boolean;
  /** Candidates dropped by the reranker (vs incoming top-K). */
  rerank_dropped?: number;
  /** True when calibrated scoring ran and nothing cleared `min_relevance`. */
  no_good_match?: boolean;
  /** Best calibrated relevance seen (pre-threshold); null when uncalibrated. */
  top_relevance?: number | null;
  /**
   * Search scope, set by the host backend (not by DocHybridSearch itself):
   * 'project' when the search was filtered to project-linked collections,
   * 'all' when it ran over the global corpus.
   */
  scope?: 'project' | 'all';
  /** Names of the collections searched when scope === 'project'. */
  scoped_collections?: string[];
  /** Remote hits rejected because the local chunk is pending/stale. */
  stale_vector_hits?: number;
  /** Fraction of persisted chunks with a confirmed vector in searched collections. */
  vector_coverage?: number;
  /** Candidates available immediately before the caller's final result limit. */
  results_before_limit?: number;
  /** True when the final result limit omitted at least one candidate. */
  results_truncated?: boolean;
}

export interface DocHybridSearchEnhancementDeps {
  /** Query rewriter — used when input.enhancements.rewrite is true. */
  rewriter?: QueryRewriter | null;
  /** Reranker — used when input.enhancements.rerank is true. */
  reranker?: DocReranker | null;
}

const SNIPPET_MAX_CHARS = 480;

export class DocHybridSearch {
  private enhancements: DocHybridSearchEnhancementDeps;

  constructor(
    private docStore: DocStore,
    private embeddingService: EmbeddingService | null,
    private vectorStore: VectorStore | null,
    private collectionLookup: (name: string) => number | null = (name) => {
      return docStore.getCollectionByName(name)?.id ?? null;
    },
    enhancements: DocHybridSearchEnhancementDeps = {},
  ) {
    this.enhancements = enhancements;
  }

  async search(input: DocSearchInput): Promise<{
    results: DocSearchResult[];
    diag: DocSearchDiagnostics;
  }> {
    input.signal?.throwIfAborted();
    const maxResults = positiveEnvInt('MCP_DOC_SEARCH_MAX_RESULTS', DEFAULT_MAX_RESULTS);
    const requestedLimit = Number(input.limit ?? 5);
    const limit = clamp(Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 5, 1, maxResults);
    const rewriter = this.enhancements.rewriter ?? null;
    const reranker = this.enhancements.reranker ?? null;
    const wantRewrite = !!input.enhancements?.rewrite && rewriter != null;
    const wantRerank = !!input.enhancements?.rerank && reranker != null;

    // When rerank is requested we over-fetch beyond `limit` so the LLM
    // has more candidates to reorder. The final result is still truncated
    // to `limit` after rerank.
    const requestedRerankLimit = Number(input.enhancements?.top_k_for_rerank);
    const rerankLimit = Number.isFinite(requestedRerankLimit)
      ? Math.floor(requestedRerankLimit)
      : limit * DEFAULT_RERANK_MULTIPLIER;
    const effectiveLimit = wantRerank
      ? clamp(
          rerankLimit,
          limit,
          Math.max(
            limit,
            positiveEnvInt('MCP_DOC_RERANK_MAX_CANDIDATES', DEFAULT_MAX_RERANK_CANDIDATES),
          ),
        )
      // Over-fetch one result so ordinary (non-reranked) searches can report
      // an honest lower-bound proof that the caller's top-K omitted more.
      : limit + 1;

    const ftsBudget = effectiveLimit * 4;
    const vectorBudget = effectiveLimit * 4;

    // Resolve collection filter (name → id, or a project-scoped id subset).
    let collectionIds: number[] | undefined;
    if (input.collection) {
      const found = this.collectionLookup(input.collection);
      if (found == null) {
        // Unknown collection → no results, but don't error: the agent may
        // have guessed a collection name.
        return {
          results: [],
          diag: {
            fts_hits: 0,
            vector_hits: 0,
            mode: input.mode ?? 'hybrid',
            embedding_available: this.embeddingService != null,
            vector_available: this.vectorStore != null,
          },
        };
      }
      collectionIds = [found];
    } else if (input.collection_ids && input.collection_ids.length > 0) {
      collectionIds = input.collection_ids;
    }

    const forcedMode = input.mode;
    const useFts = forcedMode !== 'vector';
    const useVector =
      forcedMode !== 'fts' && this.embeddingService != null && this.vectorStore != null;
    let staleVectorHits = 0;

    // ─── Stage 1: query rewrite (optional) ────────────────────────
    // Produces N variants (incl. original) that each get a hybrid search.
    let queries: string[] = [input.query];
    let rewriteUsed = false;
    let rewriteVariants = 1;
    if (wantRewrite && rewriter) {
      const rewrite = await rewriter.rewrite(input.query, {
        resolveContext: input.resolveContext,
        signal: input.signal,
      });
      input.signal?.throwIfAborted();
      queries = rewrite.variants;
      rewriteUsed = rewrite.llmUsed || rewrite.cacheHit;
      rewriteVariants = rewrite.variants.length;
    }

    // ─── Stage 2: hybrid retrieval per variant (parallel) ─────────
    // Each variant produces its own (fts, vector) hit set; we merge
    // across variants AND sources in a single RRF call so all of them
    // contribute to the final ranking. When rewrite is off (1 variant),
    // this reduces to the classic dual-source RRF.
    const perVariant = await Promise.all(
      queries.map(async (q) => {
        const [fts, vec] = await Promise.all([
          useFts ? this.runFts(q, collectionIds, ftsBudget) : Promise.resolve([] as RankedHit[]),
          useVector ? this.runVector(q, collectionIds, vectorBudget, (n) => { staleVectorHits += n; }, input.signal) : Promise.resolve([] as RankedHit[]),
        ]);
        return { fts, vec };
      }),
    );

    input.signal?.throwIfAborted();

    // Aggregate per-source totals for diagnostics.
    const totalFts = perVariant.reduce((acc, v) => acc + v.fts.length, 0);
    const totalVector = perVariant.reduce((acc, v) => acc + v.vec.length, 0);

    const mode: 'hybrid' | 'fts' | 'vector' = forcedMode
      ?? (useVector && useFts ? 'hybrid' : useVector ? 'vector' : 'fts');

    // Build the source list for RRF: one entry per (variant, source) pair
    // with non-empty items. Naming variant_idx-source distinguishes the
    // contributions so RRF spreads weight across rather than collapsing
    // duplicates from the same variant.
    const sources: Array<{ name: string; items: RankedHit[] }> = [];
    perVariant.forEach((v, idx) => {
      if (v.fts.length > 0) sources.push({ name: `fts_v${idx}`, items: v.fts });
      if (v.vec.length > 0) sources.push({ name: `vector_v${idx}`, items: v.vec });
    });

    // RRF merge — reuses the same K=60 constant the indexer uses.
    // Pre-ranked sources feed `rrfMerge`; if we only have one source,
    // shortcut and skip the per-source-score expansion.
    const merged: Array<RankedHit & { rrfScore?: number }> = sources.length > 1
      ? rrfMerge(sources, { k: RRF_DEFAULT_K, limit: effectiveLimit })
      : (sources[0]?.items ?? []).slice(0, effectiveLimit).map((h) => ({ ...h, rrfScore: h.score }));

    // Hydrate chunks (we have only ids so far).
    const chunkIds = merged.map((m) => Number(m.candidateId));
    const chunks = this.docStore.getChunksByIds(chunkIds);
    const byId = new Map(chunks.map((c) => [c.id, c]));

    let results: DocSearchResult[] = [];
    for (const m of merged) {
      const chunkId = Number(m.candidateId);
      const chunk = byId.get(chunkId);
      if (!chunk) continue;
      const collection = this.docStore.getCollection(chunk.collection_id);
      const snippet = buildSnippet(chunk);
      results.push({
        chunk_id: chunk.id,
        collection: collection?.name ?? '(unknown)',
        source_id: chunk.source_id,
        source_uri: chunk.source_uri,
        heading_path: chunk.heading_path,
        anchor: chunk.anchor,
        api_symbol: chunk.api_symbol,
        api_signature: chunk.api_signature,
        snippet: snippet.text,
        snippet_source_chars: snippet.sourceChars,
        snippet_retained_chars: snippet.retainedChars,
        snippet_truncated: snippet.truncated,
        score: m.rrfScore ?? m.score,
        // Uncalibrated until the reranker (Stage 3) overwrites these.
        relevance: null,
        relevance_source: 'rrf',
        summary: chunk.summary,
        concepts: chunk.concepts,
      });
    }

    // ─── Stage 3: rerank (optional) ───────────────────────────────
    let rerankUsed = false;
    let rerankDropped = 0;
    if (wantRerank && reranker && results.length > 1) {
      const candidates: Array<RerankCandidate & { __result: DocSearchResult }> = results.map((r) => ({
        chunk_id: r.chunk_id,
        heading_path: r.heading_path,
        // Preview truncation must not hide the relevant part from the model.
        snippet: byId.get(r.chunk_id)?.content.slice(0, 8_000) ?? r.snippet,
        pre_rerank_score: r.score,
        concepts: r.concepts,
        __result: r,
      }));
      const rerank = await reranker.rerank(input.query, candidates, {
        resolveContext: input.resolveContext,
        signal: input.signal,
      });
      input.signal?.throwIfAborted();
      rerankUsed = rerank.reranked;
      rerankDropped = rerank.dropped;
      results = rerank.candidates.map((c) => c.__result);
      // Surface the calibrated 0-1 score the reranker just computed, instead
      // of leaving the uninterpretable RRF score as the only signal.
      if (rerank.reranked && rerank.scoreByChunkId) {
        for (const r of results) {
          const s = rerank.scoreByChunkId.get(r.chunk_id);
          if (s != null) {
            r.relevance = s;
            r.relevance_source = 'rerank';
          }
        }
      }
    }

    // ─── Stage 4: relevance threshold (optional) ──────────────────
    // Honest "no good match": only drops hits when we have calibrated
    // (rerank) scores. Computed pre-truncate so top_relevance reflects the
    // true best candidate even when everything is below the cutoff.
    let noGoodMatch = false;
    let topRelevance: number | null = rerankUsed
      ? results.reduce<number>((max, r) => Math.max(max, r.relevance ?? 0), 0)
      : null;
    if (input.min_relevance != null) {
      const outcome = applyThreshold(results, input.min_relevance);
      results = outcome.kept;
      noGoodMatch = outcome.noGoodMatch;
      if (outcome.topRelevance != null) topRelevance = outcome.topRelevance;
    }

    // Final truncate to the caller's requested `limit`, retaining structural
    // evidence so every host can distinguish top-K omission from a full set.
    const resultsBeforeLimit = results.length;
    const resultsTruncated = resultsBeforeLimit > limit;
    if (resultsTruncated) {
      results = results.slice(0, limit);
    }

    return {
      results,
      diag: {
        fts_hits: totalFts,
        vector_hits: totalVector,
        mode,
        embedding_available: this.embeddingService != null,
        vector_available: this.vectorStore != null,
        rewrite_used: rewriteUsed,
        rewrite_variants: rewriteVariants,
        rerank_used: rerankUsed,
        rerank_dropped: rerankDropped,
        no_good_match: noGoodMatch,
        top_relevance: topRelevance,
        stale_vector_hits: staleVectorHits,
        vector_coverage: this.vectorCoverage(collectionIds),
        results_before_limit: resultsBeforeLimit,
        results_truncated: resultsTruncated,
      },
    };
  }

  // ─── Source fan-outs ─────────────────────────────────────────────

  private async runFts(query: string, collectionIds: number[] | undefined, budget: number): Promise<RankedHit[]> {
    const hits = this.docStore.searchChunksFts(query, { collectionIds, limit: budget });
    // FTS rank is negative bm25 (lower is better); convert to ascending
    // rank order (1, 2, …) for RRF — `rrfMerge` only looks at position.
    return hits.map((h) => ({ candidateId: String(h.chunk_id), score: -h.rank }));
  }

  private async runVector(
    query: string,
    collectionIds: number[] | undefined,
    budget: number,
    onStale: (count: number) => void,
    signal?: AbortSignal,
  ): Promise<RankedHit[]> {
    if (!this.embeddingService || !this.vectorStore) return [];

    // Doc vectors are isolated PER COLLECTION via a namespace (docNamespace).
    // A filtered search (single collection or a project-linked subset) only
    // queries those namespaces: no foreign (code) vectors pollute the top-K,
    // so no over-fetch and no in-memory post-filter needed. "All collections"
    // → fan-out one namespaced query per collection and merge by score
    // (collections are few). This replaces the old "fetch 10× and filter in
    // memory" hack that existed only because code+docs shared one index.
    const ids = collectionIds ?? this.docStore.listCollections().map((c) => c.id);
    const searchCollection = async (id: number): Promise<RankedHit[]> => {
      signal?.throwIfAborted();
      const namespace = docNamespace(id);
      try {
        // Each collection may still serve a different active generation while
        // an atomic profile migration rolls forward. Encode in that exact
        // namespace's model space; one failed target degrades only its branch.
        const { vector, generationId } = await embedQueryForNamespace(this.embeddingService!, namespace, query, signal ? { signal } : undefined);
        signal?.throwIfAborted();
        const results = await this.searchNamespace(vector, namespace, budget, onStale, generationId);
        signal?.throwIfAborted();
        return results;
      } catch {
        signal?.throwIfAborted();
        return [];
      }
    };
    if (ids.length === 1) return searchCollection(ids[0]);

    const perCollection: RankedHit[][] = new Array(ids.length);
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < ids.length) {
        signal?.throwIfAborted();
        const index = cursor++;
        perCollection[index] = await searchCollection(ids[index]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, ids.length) }, () => worker()));
    return perCollection
      .flat()
      .sort((a, b) => b.score - a.score)
      .slice(0, budget);
  }

  /** One namespaced vector query → ranked chunk hits. */
  private async searchNamespace(
    queryVec: number[],
    namespace: string,
    budget: number,
    onStale: (count: number) => void,
    generationId?: number,
  ): Promise<RankedHit[]> {
    let matches: Awaited<ReturnType<VectorStore['search']>>;
    try {
      matches = await this.vectorStore!.search(queryVec, { topK: budget, namespace, generationId });
    } catch {
      return [];
    }
    const parsed = matches.map((m) => ({
      match: m,
      chunkId: Number(m.metadata?.chunk_id ?? extractChunkIdFromVectorId(m.id)),
    })).filter((x) => Number.isFinite(x.chunkId));
    const chunks = this.docStore.getChunksByIds(parsed.map((x) => x.chunkId));
    const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
    const hits: RankedHit[] = [];
    let stale = 0;
    for (const { match: m, chunkId } of parsed) {
      // Vector ids encode the chunk id; metadata carries it as a fallback in
      // case the id format ever rotates.
      const chunk = byId.get(chunkId);
      // The router read from the namespace's atomically activated generation;
      // semantic_items is its acceptance ledger. A missing corpus row is stale,
      // but doc_chunks.embedding_* is only a compatibility mirror and must not
      // veto an otherwise active local vector.
      if (!chunk) {
        stale++;
        continue;
      }
      hits.push({ candidateId: String(chunkId), score: m.score });
    }
    if (stale > 0) onStale(stale);
    return hits;
  }

  private vectorCoverage(collectionIds: number[] | undefined): number {
    // Some embedders/search callers intentionally provide a read-only store
    // facade (and older plugins may not yet expose the coverage counters).
    // Diagnostics must degrade to unknown/zero, never fail the actual search.
    const store = this.docStore as Partial<DocStore>;
    if (typeof store.countChunksByCollection !== 'function'
      || typeof store.countIndexedVectorsByCollection !== 'function') return 0;
    if (!collectionIds && typeof store.listCollections !== 'function') return 0;
    const ids = collectionIds ?? store.listCollections!.call(this.docStore).map((c) => c.id);
    let total = 0;
    let indexed = 0;
    for (const id of ids) {
      total += store.countChunksByCollection.call(this.docStore, id);
      indexed += store.countIndexedVectorsByCollection.call(this.docStore, id);
    }
    return total > 0 ? Math.max(0, Math.min(1, indexed / total)) : 0;
  }
}

/**
 * Source-level ranked hit. Satisfies the `Rankable` shape required by
 * `rrfMerge` (string `candidateId`) while keeping the raw per-source
 * score around for the single-source fallback path.
 */
interface RankedHit { candidateId: string; score: number }

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function buildSnippet(chunk: DocChunk): {
  text: string;
  sourceChars: number;
  retainedChars: number;
  truncated: boolean;
} {
  const lead = chunk.summary ? `${chunk.summary}\n\n` : '';
  const truncated = chunk.content.length > SNIPPET_MAX_CHARS;
  let retainedBody = chunk.content;
  if (truncated) {
    let end = SNIPPET_MAX_CHARS;
    const final = chunk.content.charCodeAt(end - 1);
    const next = chunk.content.charCodeAt(end);
    if (final >= 0xd800 && final <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
    retainedBody = chunk.content.slice(0, end);
  }
  const body = truncated
    ? retainedBody + '…'
    : chunk.content;
  return {
    text: (lead + body).trim(),
    sourceChars: chunk.content.length,
    retainedChars: retainedBody.length,
    truncated,
  };
}

/**
 * Encode/decode helpers for the vector_id format used when upserting
 * doc chunks: `doc_chunk:<chunk_id>`. The prefix lets a future analyzer
 * tell doc-corpus vectors apart from code-corpus vectors at a glance,
 * while still recovering the chunk id without a metadata round-trip.
 */
export function vectorIdForChunk(chunkId: number): string {
  return `doc_chunk:${chunkId}`;
}

function extractChunkIdFromVectorId(vectorId: string): string | null {
  if (!vectorId.startsWith('doc_chunk:')) return null;
  return vectorId.slice('doc_chunk:'.length) || null;
}
