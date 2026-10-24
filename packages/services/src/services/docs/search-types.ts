import type { ResolveContext } from '../../pipelines/index.js';
import type { QueryRewriter } from './query-rewriter.js';
import type { DocReranker } from './reranker.js';
import { type RelevanceSource } from './relevance-policy.js';
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

/**
 * Source-level ranked hit. Satisfies the `Rankable` shape required by
 * `rrfMerge` (string `candidateId`) while keeping the raw per-source
 * score around for the single-source fallback path.
 */
export interface RankedHit { candidateId: string; score: number }
