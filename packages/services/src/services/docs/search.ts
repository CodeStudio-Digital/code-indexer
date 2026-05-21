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
import type { EmbeddingService } from '@mcp/indexer/search/embeddings.js';
import type { VectorStore } from '@mcp/store/vectors.js';
import { rrfMerge, RRF_DEFAULT_K } from '@mcp/candidate-pipeline';
import type { DocChunk, DocStore } from '@mcp/store/doc-store.js';
import type { ResolveContext } from '../../pipelines/index.js';
import type { QueryRewriter } from './query-rewriter.js';
import type { Reranker, RerankCandidate } from './reranker.js';

/** Metadata filter values stored on the vector store side. */
const VECTOR_FILTER_CORPUS = 'docs';
const VECTOR_FILTER_TYPE = 'doc_chunk';

/** Default top-K expanded for rerank — gives the reranker headroom. */
const DEFAULT_RERANK_TOP_K = 20;
/** Hard cap on rerank top-K (cost control). */
const MAX_RERANK_TOP_K = 50;

export interface DocSearchEnhancements {
  /** Run query-rewriter and merge variants via RRF. Default false. */
  rewrite?: boolean;
  /** Run reranker on hybrid output before final truncate. Default false. */
  rerank?: boolean;
  /** Top-K to pull before rerank. Default 20, capped at MAX_RERANK_TOP_K. */
  top_k_for_rerank?: number;
}

export interface DocSearchInput {
  /** Natural-language query. */
  query: string;
  /** Optional: restrict to a single collection name. */
  collection?: string;
  /** Top-K cap. Default 5; clamped to [1, 20]. */
  limit?: number;
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
  snippet: string;
  score: number;
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
}

export interface DocHybridSearchEnhancementDeps {
  /** Query rewriter — used when input.enhancements.rewrite is true. */
  rewriter?: QueryRewriter | null;
  /** Reranker — used when input.enhancements.rerank is true. */
  reranker?: Reranker | null;
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
    const limit = clamp(input.limit ?? 5, 1, 20);
    const rewriter = this.enhancements.rewriter ?? null;
    const reranker = this.enhancements.reranker ?? null;
    const wantRewrite = !!input.enhancements?.rewrite && rewriter != null;
    const wantRerank = !!input.enhancements?.rerank && reranker != null;

    // When rerank is requested we over-fetch beyond `limit` so the LLM
    // has more candidates to reorder. The final result is still truncated
    // to `limit` after rerank.
    const effectiveLimit = wantRerank
      ? clamp(
          input.enhancements?.top_k_for_rerank ?? DEFAULT_RERANK_TOP_K,
          limit,
          MAX_RERANK_TOP_K,
        )
      : limit;

    const ftsBudget = Math.max(effectiveLimit * 4, 20);
    const vectorBudget = Math.max(effectiveLimit * 4, 20);

    // Resolve collection filter (name → id).
    let collectionId: number | undefined;
    let collectionName: string | undefined;
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
      collectionId = found;
      collectionName = input.collection;
    }

    const forcedMode = input.mode;
    const useFts = forcedMode !== 'vector';
    const useVector =
      forcedMode !== 'fts' && this.embeddingService != null && this.vectorStore != null;

    // ─── Stage 1: query rewrite (optional) ────────────────────────
    // Produces N variants (incl. original) that each get a hybrid search.
    let queries: string[] = [input.query];
    let rewriteUsed = false;
    let rewriteVariants = 1;
    if (wantRewrite && rewriter) {
      const rewrite = await rewriter.rewrite(input.query, {
        resolveContext: input.resolveContext,
      });
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
          useFts ? this.runFts(q, collectionId, ftsBudget) : Promise.resolve([] as RankedHit[]),
          useVector ? this.runVector(q, collectionName, vectorBudget) : Promise.resolve([] as RankedHit[]),
        ]);
        return { fts, vec };
      }),
    );

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
      results.push({
        chunk_id: chunk.id,
        collection: collection?.name ?? '(unknown)',
        source_id: chunk.source_id,
        source_uri: chunk.source_uri,
        heading_path: chunk.heading_path,
        snippet: buildSnippet(chunk),
        score: m.rrfScore ?? m.score,
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
        snippet: r.snippet,
        pre_rerank_score: r.score,
        concepts: r.concepts,
        __result: r,
      }));
      const rerank = await reranker.rerank(input.query, candidates, {
        resolveContext: input.resolveContext,
      });
      rerankUsed = rerank.reranked;
      rerankDropped = rerank.dropped;
      results = rerank.candidates.map((c) => c.__result);
    }

    // Final truncate to the caller's requested `limit`.
    if (results.length > limit) {
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
      },
    };
  }

  // ─── Source fan-outs ─────────────────────────────────────────────

  private async runFts(query: string, collectionId: number | undefined, budget: number): Promise<RankedHit[]> {
    const hits = this.docStore.searchChunksFts(query, { collectionId, limit: budget });
    // FTS rank is negative bm25 (lower is better); convert to ascending
    // rank order (1, 2, …) for RRF — `rrfMerge` only looks at position.
    return hits.map((h) => ({ candidateId: String(h.chunk_id), score: -h.rank }));
  }

  private async runVector(query: string, collectionName: string | undefined, budget: number): Promise<RankedHit[]> {
    if (!this.embeddingService || !this.vectorStore) return [];
    let queryVec: number[];
    try {
      const result = await this.embeddingService.embedQuery(query);
      queryVec = result.vector;
    } catch {
      return [];
    }
    // We do NOT pass any metadata filter to the vector store —
    // Cloudflare Vectorize requires `createMetadataIndex` to be called
    // BEFORE any upsert for a metadata key to be filterable, and the
    // common provisioning path doesn't declare ANY indexes. The result
    // is "filter present → 0 hits, no error" (silent). The
    // `/api/docs/vectors/diagnose` endpoint surfaced this on
    // 2026-05-20: unfiltered returned the right top-K; ANY filter
    // returned 0. We over-fetch and post-filter by `corpus / type /
    // collection` in memory — cheap and correct under all provisioning
    // shapes (declared or not).
    //
    // Risk: if the same Vectorize index also holds NON-doc vectors
    // (e.g., code chunks from the regular indexer), they pollute the
    // initial top-K. We over-fetch ~10x to leave headroom; if a non-doc
    // candidate dominates the head, the `corpus` post-filter drops it
    // and downstream RRF still finds doc hits via FTS.
    const remoteTopK = Math.min(Math.max(budget * 10, 50), 500);
    let matches: Awaited<ReturnType<VectorStore['search']>>;
    try {
      matches = await this.vectorStore.search(queryVec, { topK: remoteTopK });
    } catch {
      return [];
    }
    const hits: RankedHit[] = [];
    for (const m of matches) {
      // Vector ids encode the chunk id; the metadata also carries it as
      // a fallback in case we ever rotate id formats.
      const chunkIdStr = m.metadata?.chunk_id ?? extractChunkIdFromVectorId(m.id);
      const chunkId = chunkIdStr ? Number(chunkIdStr) : NaN;
      if (!Number.isFinite(chunkId)) continue;
      // Apply the corpus/type/collection filters in-memory (see comment
      // above). Skips foreign vectors (code chunks, etc.) sharing the
      // same Vectorize index, plus narrows to the requested collection.
      if (m.metadata?.corpus !== VECTOR_FILTER_CORPUS) continue;
      if (m.metadata?.type !== VECTOR_FILTER_TYPE) continue;
      if (collectionName && m.metadata?.collection !== collectionName) continue;
      hits.push({ candidateId: String(chunkId), score: m.score });
      if (hits.length >= budget) break;
    }
    return hits;
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

function buildSnippet(chunk: DocChunk): string {
  const lead = chunk.summary ? `${chunk.summary}\n\n` : '';
  const body = chunk.content.length > SNIPPET_MAX_CHARS
    ? chunk.content.slice(0, SNIPPET_MAX_CHARS) + '…'
    : chunk.content;
  return (lead + body).trim();
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
