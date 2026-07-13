/**
 * Shared types for the documentation-ingestion pipeline.
 *
 * The candidate-pipeline framework is generic over `PipelineQuery` and
 * `PipelineCandidate`; this file pins the concrete shapes used by the
 * `doc_ingest` pipeline (Sources/Hydrators/Filters/Selector).
 */
import type { PipelineCandidate, PipelineQuery } from '@mcp/candidate-pipeline';

/**
 * Stages of the ingestion pipeline. Mirrors the source `status` machine —
 * surfaces in `IndexDocumentationProgress.phase` so the UI can render the
 * right label without parsing free text.
 */
export type DocIngestPhase =
  | 'fetching'      // URL crawl or PDF page extraction in flight
  | 'reading'       // folder source: glob + per-file read from disk
  | 'gating'        // relevance gate deciding keep/drop
  | 'chunking'      // section chunker materializing chunks
  | 'enriching'     // per-chunk LLM enrichment
  | 'embedding'     // embedding model batched calls
  | 'paused'
  | 'paused_limit'
  | 'cancelled'
  | 'done'
  | 'error';

/** Progress frame emitted by `IndexDocumentationUseCase`. */
export interface DocIngestProgress {
  phase: DocIngestPhase;
  current: number;
  total: number;
  /** Free-text label for the active item — e.g. URL or PDF page. */
  label?: string;
  pages_fetched?: number;
  pages_accepted?: number;
  pages_rejected?: number;
  /** Pages that needed the headless browser due to bot detection. */
  pages_via_browser?: number;
  chunks_indexed?: number;
  cost_usd?: number;
  elapsed_ms?: number;
  run_id?: number;
  state?: 'running' | 'paused' | 'paused_limit' | 'cancelled' | 'completed' | 'failed';
  files_changed?: number;
  files_unchanged?: number;
  files_skipped?: number;
  chunks_persisted?: number;
  embeddings_completed?: number;
  embeddings_pending?: number;
  enrichments_completed?: number;
  enrichments_pending?: number;
  searchable?: boolean;
  rate_per_sec?: number;
  eta_ms?: number | null;
  workers_active?: number;
  workers_configured?: number;
  extraction_ms?: number;
}

/** Final result returned by `IndexDocumentationUseCase.run()`. */
export interface DocIngestResult {
  source_id: number;
  chunks_indexed: number;
  pages_fetched: number;
  pages_accepted: number;
  pages_rejected: number;
  /** Pages that needed the headless browser due to bot detection. */
  pages_via_browser: number;
  cost_usd: number;
  elapsed_ms: number;
  run_id?: number;
  state?: 'paused' | 'paused_limit' | 'cancelled' | 'completed';
  searchable?: boolean;
}

/** Pre-flight estimate returned by `dryRun()` — chunks + projected cost. */
export interface DocIngestEstimate {
  pages_to_fetch: number;
  pages_likely_accepted: number;
  estimated_chunks: number;
  estimated_tokens: number;
  estimated_cost_usd: number;
  notes?: string[];
}

/**
 * A page produced by the fetcher (URL crawl or PDF extraction). Both flows
 * funnel into the same chunker → enricher → embedder pipeline, so we
 * normalize them into a single `RawPage` shape.
 */
export interface RawPage extends PipelineCandidate {
  /** Stable identifier for the candidate-pipeline (URL or "pdf://<source>#page=N"). */
  candidateId: string;
  /** Original URL or `pdf://<source_id>#page=N`. */
  uri: string;
  /** Human-friendly title — `<h1>` / PDF outline node / first heading. */
  title: string | null;
  /** Cleaned-up Markdown content. Already stripped of nav/footer noise. */
  markdown: string;
  /** Provenance: how this page got here. */
  source: 'url' | 'pdf' | 'folder';
  /** For URL: depth from the seed in the BFS frontier. */
  depth?: number;
  /** Raw byte count of the fetched body — useful for heuristics. */
  bytes?: number;
  /**
   * Which render backend produced this page. `plain` is the default
   * (Node fetch); `browser` means the fetcher escalated to Playwright
   * after detecting bot-block signals. Surfaced in the UI as a badge.
   */
  via?: 'plain' | 'browser';
  /**
   * Bot-detection signals that fired when this page was fetched. Non-
   * empty even on success when escalation worked (so the UI can tell
   * "we tried plain, got blocked, escalated, got real content"). When
   * present without `via='browser'`, escalation was attempted but the
   * browser backend was unavailable.
   */
  blocked_signals?: string[];
  /**
   * Set by `RelevanceGateFilter`. Pages with `is_documentation === false`
   * are removed from the kept set; the value is preserved for telemetry.
   */
  is_documentation?: boolean;
  /** Diagnostic reason from the gate or pre-filter. */
  gate_reason?: string;
  /** Canonical public URL extracted from local/static HTML. */
  canonical_uri?: string | null;
  /** Extraction adapter used for diagnostics and doc-type inference. */
  extractor?: 'generic' | 'unity-script-reference';
}

/** Query passed through the ingest pipeline. */
export interface DocIngestQuery extends PipelineQuery {
  /** Hardcoded for the ingest pipeline. */
  queryId: string;
  source_id: number;
  collection_id: number;
  source_uri: string;
  source_type: 'pdf' | 'url';
  resolveContext?: { sessionId?: number; companySessionId?: number; templateId?: number };
}
