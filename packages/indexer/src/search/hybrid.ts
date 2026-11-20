import type { CodeIndexDB } from '@mcp/store/db.js';
import { randomUUID } from 'node:crypto';
import type { VectorStore } from '@mcp/store/vectors.js';
import { ftsTokens } from '@mcp/store/db/fts-query.js';
import type { EmbeddingService } from '@mcp/indexer/search/embeddings.js';
import {
  embedQueryForNamespace,
  NullEmbeddingService,
} from '@mcp/indexer/search/embeddings.js';
import type { HyDEService } from '@mcp/indexer/search/hyde.js';
import type { RerankerService } from '@mcp/indexer/search/reranker.js';
import { planQuery } from '@mcp/indexer/search/planner.js';
import { buildConceptFtsMatch } from './lexical-concepts.js';
import { codeResultInScope, codeSearchFolders, codeVectorFilter, distinctCodeMatches, rerankWithinSlots } from './code-vector-matches.js';
import { NullReranker } from '@mcp/indexer/search/reranker.js';
import type { RecentFilesSource } from '@mcp/indexer/search/recent-files-source.js';
import type { HybridSearchResult, SearchMode, SearchType, DBFile, DBSymbol, ContextSnapshot } from '@mcp/shared/types.js';
import { codeNamespace, snapshotNamespace } from '@mcp/shared/vector-namespace.js';
import type { CandidatePipeline, TelemetrySink } from '@mcp/candidate-pipeline';
import {
  createHybridSearchPipeline,
  rerankDocumentText,
  runHybridSearchPipeline,
  codeQueryVariants,
  type HybridSearchPipelineCandidate,
  type HybridSearchPipelineQuery,
} from '@mcp/indexer/search/hybrid-pipeline.js';
import type {
  SemanticQueryClass,
  SemanticSearchTelemetryContext,
  SemanticSearchTelemetrySink,
  SemanticSearchTelemetrySummary,
} from '@mcp/indexer/search/search-telemetry.js';

/** Diagnostic info returned alongside search results. */
export interface SearchDiagnostics {
  /** Observed at retrieval boundaries; not a transaction snapshot. */
  structuralRevision?: string;
  structuralRevisionAfter?: string;
  structuralRevisionStable?: boolean;
  vectorAvailable: boolean;
  embeddingAvailable: boolean;
  requestedMode?: SearchMode;
  plannedMode?: 'fts' | 'vector' | 'hybrid';
  effectiveMode?: 'fts' | 'vector' | 'hybrid';
  generationUsed?: number;
  embedder?: string;
  reranker?: string;
  fallback?: boolean;
  fallbackReason?: string;
  queryVariants?: string[];
  vectorRawMatches?: number;
  vectorRehydrated?: number;
  vectorSkippedReason?: string;
  vectorError?: string;
  ftsCount?: number;
  /** Set when the planner chose a backend on the caller's behalf. */
  plannerMode?: 'fts' | 'vector' | 'hybrid';
  plannerReason?: string;
  /**
   * Number of results contributed by the RecentFilesSource stream in hybrid
   * mode. Unset when no source is wired.
   */
  recentFilesCount?: number;
  /**
   * Number of neighbors contributed by the 1-hop graph-expansion stream
   * (hybrid mode; `MCP_PIPELINES_GRAPH_EXPANSION=0` disables it).
   */
  graphExpansionCount?: number;
  /**
   * Results contributed by the raw-content word index
   * (`file_contents_fts`, migration 140) — the lexical stream that works on
   * structural-only projects and matches text living only in code bodies.
   * Unset when the stream is off (`MCP_FTS_CONTENT_STREAM=0`) or empty.
   */
  contentCount?: number;
  /** True only when this response was served by the short-lived query cache. */
  cacheHit?: boolean;
  /** Complete retrieval + fusion + reranking latency for this request. */
  totalTimeMs?: number;
  /** Whether the cross-encoder successfully replaced the RRF ordering. */
  rerankerApplied?: boolean;
  /** Expanded candidate set submitted to the reranker. */
  rerankerCandidates?: number;
  /** Valid rows returned by the reranker. */
  rerankerReturned?: number;
  /** Reranker error when the pipeline preserved the RRF ordering. */
  rerankerError?: string;
  rerankerSkippedReason?: string;
  /** Correlates this response with privacy-safe project telemetry/outcomes. */
  telemetryRequestId?: string;
}

/** Reject a mislabeled semantic measurement even when a store and model are present. */
export function verifySemanticRetrieval(diagnostics: SearchDiagnostics, expectCandidates: boolean): void {
  if (diagnostics.vectorError || diagnostics.rerankerError || diagnostics.fallback) {
    throw new Error(diagnostics.vectorError ?? diagnostics.rerankerError ?? diagnostics.fallbackReason ?? 'Semantic search degraded');
  }
  if (expectCandidates && ((diagnostics.vectorRawMatches ?? 0) <= 0 || (diagnostics.vectorRehydrated ?? 0) <= 0)) {
    throw new Error(diagnostics.vectorSkippedReason ?? 'Semantic search returned no usable vector candidates. Check the selected folders and active index generation.');
  }
}

export interface HybridSearchOptions {
  mode?: SearchMode;
  type?: SearchType;
  limit?: number;
  /** Stable latest-wins identity for an interactive caller. */
  supersessionKey?: string;
  /** Abort signal owned by the transport/request lifecycle. */
  signal?: AbortSignal;
  /** Force a fresh execution for diagnostics/benchmarks. Never used by normal consumers. */
  bypassCache?: boolean;
  /** The caller already generated this variant. Applies to the vector branch. */
  preExpanded?: boolean;
  /** Transport/session attribution. Raw query text is never persisted. */
  telemetryContext?: SemanticSearchTelemetryContext;
}

export interface GlobalHybridSearchResult {
  projectId: number;
  projectName: string;
  result: HybridSearchResult;
}

const RRF_K = 60;

/** Positive-integer env knob with a fallback (NaN/0/negative → fallback). */
function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

function classifyQuery(
  query: string,
  plannedMode: 'fts' | 'vector' | 'hybrid',
): SemanticQueryClass {
  if (plannedMode === 'fts') return 'identifier';
  const trimmed = query.trim();
  if (!trimmed) return 'unknown';
  if (
    /^(?:how|what|where|why|when|which|find|show|explain|como|onde|porque|qual|encontre|mostre)\b/i
      .test(trimmed)
    || /\s/.test(trimmed)
  ) {
    return 'natural_language';
  }
  return 'concept';
}

export class HybridSearch {
  private reranker: RerankerService;
  private memoryEmbeddingService: EmbeddingService;
  private memoryReranker: RerankerService;
  /**
   * Optional in-memory hot cache of recently-touched files. When wired, it is
   * one normal source in the canonical hybrid pipeline.
   */
  private recentFilesSource: RecentFilesSource | null;
  /**
   * Optional telemetry sink. When wired, the pipeline emits per-stage rows
   * to `pipeline_telemetry`. Unset →
   * pipeline still works, just no observability writes.
   */
  private pipelineTelemetry: TelemetrySink | null;
  private searchTelemetry: SemanticSearchTelemetrySink | null;
  /**
   * Lazy-instantiated hybrid pipeline. Built on first invocation; reused
   * across calls. The factory is cheap (no I/O), but constructing it
   * once amortizes some closure setup across many searches.
   */
  private hybridPipeline: CandidatePipeline<HybridSearchPipelineQuery, HybridSearchPipelineCandidate> | null = null;
  /** Retrieval-only twin used by global search. It performs the complete
   * source/RRF path but deliberately omits per-project reranking so one
   * cross-encoder call can compare candidates across every project. */
  private globalRetrievalPipeline: CandidatePipeline<HybridSearchPipelineQuery, HybridSearchPipelineCandidate> | null = null;

  /** LRU query cache. Semantic revisions in the key prevent cross-generation/target hits. */
  private queryCache = new Map<string, { results: HybridSearchResult[]; diagnostics: SearchDiagnostics; ts: number }>();
  private readonly queryCacheMax = 128;
  private readonly queryCacheTtlMs = 5 * 60 * 1000; // 5 min

  constructor(
    private db: CodeIndexDB,
    private vectorStore: VectorStore | null,
    private embeddingService: EmbeddingService,
    private hydeService: HyDEService | null = null,
    reranker?: RerankerService | null,
    recentFilesSource?: RecentFilesSource | null,
    pipelineTelemetry?: TelemetrySink | null,
    memoryEmbeddingService?: EmbeddingService | null,
    memoryReranker?: RerankerService | null,
    searchTelemetry?: SemanticSearchTelemetrySink | null,
  ) {
    this.reranker = reranker ?? new NullReranker();
    this.recentFilesSource = recentFilesSource ?? null;
    this.pipelineTelemetry = pipelineTelemetry ?? null;
    this.memoryEmbeddingService = memoryEmbeddingService ?? embeddingService;
    this.memoryReranker = memoryReranker ?? new NullReranker();
    this.searchTelemetry = searchTelemetry ?? null;
  }

  private projectReranker(projectId: number): RerankerService {
    return this.reranker.forProject?.(projectId) ?? this.reranker;
  }

  /** Single production path for hybrid retrieval. */
  private async searchViaPipeline(
    projectId: number,
    projectName: string,
    query: string,
    type: SearchType,
    limit: number,
    overFetch: number,
    diagAccum: SearchDiagnostics,
    includeReranker = true,
    requestOptions: Pick<
      HybridSearchOptions,
      'supersessionKey' | 'signal' | 'telemetryContext' | 'preExpanded'
    > = {},
  ): Promise<HybridSearchResult[]> {
    let pipeline = includeReranker ? this.hybridPipeline : this.globalRetrievalPipeline;
    if (!pipeline) {
      pipeline = createHybridSearchPipeline({
        db: this.db,
        vectorStore: this.vectorStore,
        embeddingService: this.embeddingService,
        hyde: this.hydeService,
        reranker: includeReranker ? this.reranker : new NullReranker(),
        recentFilesSource: this.recentFilesSource,
        ftsSanitize: (q, connector) => this.sanitizeFtsQuery(q, connector),
        telemetry: this.pipelineTelemetry ?? undefined,
      });
      if (includeReranker) this.hybridPipeline = pipeline;
      else this.globalRetrievalPipeline = pipeline;
    }
    const pipelineQuery: HybridSearchPipelineQuery = {
      queryId: `hybrid:${projectId}:${
        requestOptions.telemetryContext?.requestId ?? randomUUID()
      }`,
      projectId,
      projectName,
      query,
      type,
      reranker: includeReranker ? this.projectReranker(projectId) : undefined,
      vectorWeight: this.db.getProjectCatalogEntry?.(projectId)?.semantic_vector_weight,
      overFetch,
      limit,
      supersessionKey: requestOptions.supersessionKey,
      signal: requestOptions.signal,
      preExpanded: requestOptions.preExpanded,
      resolveContext: {
        sessionId: requestOptions.telemetryContext?.sessionId,
        companySessionId: requestOptions.telemetryContext?.companySessionId,
        requestId: requestOptions.telemetryContext?.requestId,
        projectId,
        consumer: requestOptions.telemetryContext?.consumer,
        queryClass: classifyQuery(query, 'hybrid'),
      },
      diag: {},
    };
    const results = await runHybridSearchPipeline(pipeline, pipelineQuery);
    // Propagate diagnostic fields the legacy code populates so the
    // user-facing SearchDiagnostics surface stays identical.
    if (pipelineQuery.diag.ftsCount !== undefined) diagAccum.ftsCount = pipelineQuery.diag.ftsCount;
    if (pipelineQuery.diag.vectorRawMatches !== undefined) diagAccum.vectorRawMatches = pipelineQuery.diag.vectorRawMatches;
    if (pipelineQuery.diag.vectorRehydrated !== undefined) diagAccum.vectorRehydrated = pipelineQuery.diag.vectorRehydrated;
    if (pipelineQuery.diag.vectorError !== undefined) diagAccum.vectorError = pipelineQuery.diag.vectorError;
    if (pipelineQuery.diag.queryVariants !== undefined) diagAccum.queryVariants = pipelineQuery.diag.queryVariants;
    if (pipelineQuery.diag.recentFilesCount !== undefined) diagAccum.recentFilesCount = pipelineQuery.diag.recentFilesCount;
    if (pipelineQuery.diag.contentCount !== undefined) diagAccum.contentCount = pipelineQuery.diag.contentCount;
    if (pipelineQuery.diag.graphExpansionCount !== undefined) diagAccum.graphExpansionCount = pipelineQuery.diag.graphExpansionCount;
    if (pipelineQuery.diag.generationUsed !== undefined) diagAccum.generationUsed = pipelineQuery.diag.generationUsed;
    if (pipelineQuery.diag.rerankerApplied !== undefined) diagAccum.rerankerApplied = pipelineQuery.diag.rerankerApplied;
    if (pipelineQuery.diag.rerankerCandidates !== undefined) diagAccum.rerankerCandidates = pipelineQuery.diag.rerankerCandidates;
    if (pipelineQuery.diag.rerankerReturned !== undefined) diagAccum.rerankerReturned = pipelineQuery.diag.rerankerReturned;
    if (pipelineQuery.diag.rerankerSkippedReason !== undefined) diagAccum.rerankerSkippedReason = pipelineQuery.diag.rerankerSkippedReason;
    if (pipelineQuery.diag.rerankerError !== undefined) {
      diagAccum.rerankerError = pipelineQuery.diag.rerankerError;
      diagAccum.fallback = true;
      diagAccum.fallbackReason = pipelineQuery.diag.rerankerError;
    }
    return results;
  }

  /**
   * Search several projects with bounded physical-DB fan-out and one global
   * reranker pass. Per-project retrieval stops after RRF; the cross-encoder
   * then compares real source text across project boundaries before top-K.
   */
  async searchGlobal(
    projects: ReadonlyArray<{ id: number; name: string }>,
    query: string,
    options?: HybridSearchOptions,
  ): Promise<GlobalHybridSearchResult[]> {
    if (projects.length === 0) return [];
    const requestedMode = options?.mode ?? 'auto';
    const type = options?.type ?? 'all';
    const limit = Math.max(1, options?.limit ?? 20);
    const mode: 'fts' | 'vector' | 'hybrid' = requestedMode === 'auto'
      ? planQuery(query).mode
      : requestedMode;
    // Keep the global cross-encoder batch bounded. This is also the high-tier
    // adaptive policy ceiling; smaller worker policies may further reduce it.
    const reranker = mode === 'hybrid' ? this.projectReranker(projects[0].id) : this.reranker;
    const revision = (service: RerankerService) => service.cacheRevision?.() ?? service.name;
    const sameTarget = mode === 'hybrid' && (!this.reranker.forProject
      || projects.every(project => revision(this.projectReranker(project.id)) === revision(reranker)));
    const requestedRerankDepth = reranker.candidatePoolSize?.(limit) ?? limit * 2;
    const rerankDepth = Math.max(limit, requestedRerankDepth);
    const gathered: GlobalHybridSearchResult[] = [];
    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (cursor < projects.length) {
        options?.signal?.throwIfAborted();
        const project = projects[cursor++];
        let results: HybridSearchResult[];
        if (mode === 'hybrid') {
          const diagnostics: SearchDiagnostics = {
            vectorAvailable: !!this.vectorStore,
            embeddingAvailable: !(this.embeddingService instanceof NullEmbeddingService),
          };
          results = await this.searchViaPipeline(
            project.id,
            project.name,
            query,
            type,
            rerankDepth,
            rerankDepth * envInt('MCP_SEARCH_OVERFETCH_MULT', 3),
            diagnostics,
            false,
            options,
          );
        } else {
          results = await this.search(project.id, project.name, query, {
            ...options,
            mode,
            type,
            limit: rerankDepth,
          });
        }
        gathered.push(...results.map((result) => ({
          projectId: project.id,
          projectName: project.name,
          result,
        })));
      }
    };

    await Promise.all(Array.from(
      { length: Math.min(4, projects.length) },
      () => worker(),
    ));
    gathered.sort((left, right) => right.result.score - left.result.score);

    const candidates = gathered.slice(0, Math.min(gathered.length, rerankDepth));
    let finalCandidates = candidates;
    if (sameTarget && candidates.length > 0 && reranker.name !== 'null' && !reranker.queryBlockReason?.(query)) {
      const foldersByProject = new Map(projects.map((project) => [project.id, codeSearchFolders(this.db, project.id)]));
      const eligible = (candidate: typeof candidates[number]) =>
        codeResultInScope(foldersByProject.get(candidate.projectId) ?? [], candidate.result);
      const scoped = candidates.filter(eligible);
      if (!scoped.length) return candidates.slice(0, limit);
      const rerankInput = scoped.map((candidate) => ({
        id: `${candidate.projectId}:${candidate.result.type}:${candidate.result.id}`,
        text: rerankDocumentText(candidate.result, this.db, candidate.projectId),
        originalScore: candidate.result.score,
      }));
      try {
        const expected = Math.min(limit, rerankInput.length);
        const reranked = await reranker.rerank(query, rerankInput, expected, {
          supersessionKey: options?.supersessionKey,
          signal: options?.signal,
        });
        const allowed = new Set(rerankInput.map((candidate) => candidate.id));
        const received = new Set<string>();
        if (reranked.length !== expected || reranked.some((row) => {
          if (!allowed.has(row.id) || received.has(row.id) || !Number.isFinite(row.score)) return true;
          received.add(row.id);
          return false;
        })) {
          throw new Error(`${reranker.name} returned an incomplete or invalid global result set`);
        }
        const byId = new Map(scoped.map((candidate) => [
          `${candidate.projectId}:${candidate.result.type}:${candidate.result.id}`,
          candidate,
        ]));
        const ordered = reranked.map((row) => {
          const candidate = byId.get(row.id)!;
          return {
            ...candidate,
            result: { ...candidate.result, score: row.score },
          };
        });
        finalCandidates = scoped.length === candidates.length ? ordered
          : rerankWithinSlots(candidates, [
            ...ordered.sort((a, b) => b.result.score - a.result.score),
            ...scoped.filter((candidate) => !received.has(`${candidate.projectId}:${candidate.result.type}:${candidate.result.id}`)),
          ], eligible, (ranked, original) => ({
            ...ranked, result: { ...ranked.result, score: original.result.score },
          }));
      } catch (error) {
        console.warn(`[hybrid-search] ${reranker.name} global rerank unavailable; preserving RRF order: ${
          error instanceof Error ? error.message : String(error)
        }`);
      }
    }

    return finalCandidates
      .sort((left, right) => right.result.score - left.result.score)
      .slice(0, limit);
  }

  /** Invalidate query cache (call after indexing). */
  invalidateCache(): void {
    this.queryCache.clear();
  }

  async telemetrySummary(
    projectId: number,
    periodDays = 30,
  ): Promise<SemanticSearchTelemetrySummary | null> {
    return await this.searchTelemetry?.summarize?.(projectId, periodDays) ?? null;
  }

  recordTelemetryOutcome(input: {
    projectId: number;
    requestId: string;
    semanticWin: boolean;
  }): void {
    if (!this.searchTelemetry?.recordOutcome) return;
    this.searchTelemetry.recordOutcome({
      schema_version: 1,
      kind: 'outcome',
      recorded_at: new Date().toISOString(),
      request_id: input.requestId,
      project_id: input.projectId,
      outcome: 'opened',
      semantic_win: input.semanticWin,
    });
  }

  /**
   * Build a cache key without doing inference. A revision resolver failure
   * disables caching for this request: serving a fresh result is safer than
   * guessing which semantic generation or reranker target produced a hit.
   */
  private queryCacheKey(
    projectId: number,
    query: string,
    mode: 'fts' | 'vector' | 'hybrid',
    type: SearchType,
    limit: number,
  ): string | null {
    try {
      const embeddingRevision = mode === 'fts'
        ? 'not-used'
        : this.embeddingService.cacheRevisionForNamespace?.(codeNamespace(projectId)) ?? 'legacy';
      const rerankerRevision = mode === 'hybrid'
        ? this.projectReranker(projectId).cacheRevision?.() ?? 'legacy'
        : 'not-used';
      return JSON.stringify([
        projectId,
        query,
        this.db.getStructuralRevision?.(projectId) ?? 'legacy',
        mode,
        type,
        limit,
        mode === 'fts' ? null : codeSearchFolders(this.db, projectId),
        mode === 'hybrid' ? this.db.getProjectCatalogEntry?.(projectId)?.semantic_vector_weight ?? 1 : null,
        embeddingRevision,
        rerankerRevision,
      ]);
    } catch {
      return null;
    }
  }

  async search(
    projectId: number,
    projectName: string,
    query: string,
    options?: HybridSearchOptions,
  ): Promise<HybridSearchResult[]> {
    const { results } = await this.searchWithDiag(projectId, projectName, query, options);
    return results;
  }

  /** Search with diagnostic info — used by the API to surface feedback. */
  async searchWithDiag(
    projectId: number,
    projectName: string,
    query: string,
    options?: HybridSearchOptions,
  ): Promise<{ results: HybridSearchResult[]; diagnostics: SearchDiagnostics }> {
    options?.signal?.throwIfAborted();
    const startedAt = performance.now();
    const requestedMode = options?.mode ?? 'auto';
    const type = options?.type ?? 'all';
    const limit = options?.limit ?? 20;
    // Per-source candidate depth before fusion. Tunable so RRF coverage can
    // be measured against latency instead of hardcoding the trade-off.
    const overFetch = limit * envInt('MCP_SEARCH_OVERFETCH_MULT', 3);

    // Resolve `auto` via the planner so callers don't pay hybrid cost
    // for queries that FTS handles in a tenth of the time. The chosen
    // mode is surfaced via diagnostics.
    let mode: 'fts' | 'vector' | 'hybrid';
    let plannerReason: string | undefined;
    if (requestedMode === 'auto') {
      const plan = planQuery(query);
      mode = plan.mode;
      plannerReason = plan.reason;
    } else {
      mode = requestedMode;
    }
    const telemetryContext = options?.telemetryContext;
    const telemetryRequestId = telemetryContext?.requestId ?? randomUUID();
    const queryClass = classifyQuery(query, mode);
    const recordTelemetry = (response: {
      results: HybridSearchResult[];
      diagnostics: SearchDiagnostics;
    }): void => {
      response.diagnostics.telemetryRequestId = telemetryRequestId;
      try {
        this.searchTelemetry?.emit({
          schema_version: 1,
          kind: 'search',
          recorded_at: new Date().toISOString(),
          request_id: telemetryRequestId,
          project_id: projectId,
          consumer: telemetryContext?.consumer ?? 'unknown',
          query_class: queryClass,
          requested_mode: requestedMode,
          planned_mode: mode,
          effective_mode: response.diagnostics.effectiveMode ?? mode,
          generation_id: response.diagnostics.generationUsed ?? null,
          cache_hit: response.diagnostics.cacheHit === true,
          fallback: response.diagnostics.fallback === true,
          result_count: response.results.length,
          total_time_ms: response.diagnostics.totalTimeMs ?? 0,
          reranker_applied: response.diagnostics.rerankerApplied === true,
          reranker_failed: !!response.diagnostics.rerankerError,
          session_scoped: !!(
            telemetryContext?.sessionId
            || telemetryContext?.companySessionId
          ),
        });
      } catch {
        // Search results must never depend on observability persistence.
      }
    };

    // Check cache (key includes resolved mode so `auto` and `hybrid`
    // share a result row when the planner picks `hybrid`).
    const structuralRevision = this.db.getStructuralRevision?.(projectId);
    const cacheKey = options?.bypassCache || options?.preExpanded
      ? null
      : this.queryCacheKey(projectId, query, mode, type, limit);
    const cached = cacheKey ? this.queryCache.get(cacheKey) : undefined;
    if (cached && Date.now() - cached.ts < this.queryCacheTtlMs) {
      // Return the diagnostics of the run that produced the entry — a
      // stripped object here made consumers (e.g. the agent-facing
      // diagnostics trailer) report "all fine" on cache hits even when the
      // cached run had degraded to FTS-only.
      const response = {
        results: cached.results,
        diagnostics: {
          ...cached.diagnostics,
          cacheHit: true,
          totalTimeMs: performance.now() - startedAt,
          telemetryRequestId,
        },
      };
      recordTelemetry(response);
      return response;
    }

    const emptyScope = mode !== 'fts' && !codeSearchFolders(this.db, projectId).length;
    const diag: SearchDiagnostics = {
      structuralRevision,
      vectorAvailable: !!this.vectorStore,
      embeddingAvailable: !(this.embeddingService instanceof NullEmbeddingService),
      requestedMode,
      plannedMode: mode,
      effectiveMode: emptyScope && mode === 'hybrid' ? 'fts' : mode,
      ...(emptyScope ? { vectorSkippedReason: 'No project folders selected for semantic search' } : {}),
      cacheHit: false,
      telemetryRequestId,
      ...(mode !== 'fts'
        ? { embedder: this.embeddingService.cacheRevisionForNamespace?.(codeNamespace(projectId))
            ?? this.embeddingService.fingerprint?.()
            ?? 'unknown' }
        : {}),
      ...(mode === 'hybrid'
        ? { reranker: this.projectReranker(projectId).cacheRevision?.() ?? this.projectReranker(projectId).name }
        : {}),
      ...(plannerReason ? { plannerMode: mode, plannerReason } : {}),
    };

    const cacheAndReturn = (r: { results: HybridSearchResult[]; diagnostics: SearchDiagnostics }) => {
      options?.signal?.throwIfAborted();
      const after = this.db.getStructuralRevision?.(projectId);
      r.diagnostics.structuralRevisionAfter = after;
      r.diagnostics.structuralRevisionStable = structuralRevision !== undefined && structuralRevision === after;
      r.diagnostics.totalTimeMs = performance.now() - startedAt;
      // A transient semantic failure must not pin an FTS-only fallback for the
      // full cache TTL. No-active/disabled namespace-aware services surface
      // through vectorError as well, and their revision changes when serving
      // becomes available again.
      const degradedSemanticResult = mode !== 'fts'
        && (!!r.diagnostics.vectorError || r.diagnostics.fallback === true);
      if (cacheKey && !degradedSemanticResult && structuralRevision === after) {
        // Evict oldest if full
        if (this.queryCache.size >= this.queryCacheMax) {
          const oldest = [...this.queryCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
          if (oldest) this.queryCache.delete(oldest[0]);
        }
        this.queryCache.set(cacheKey, { results: r.results, diagnostics: r.diagnostics, ts: Date.now() });
      }
      recordTelemetry(r);
      return r;
    };

    if (mode === 'fts') {
      const results = await this.ftsSearch(projectId, query, type, limit);
      options?.signal?.throwIfAborted();
      diag.ftsCount = results.length;
      // Top-up from the raw-content index so identifier queries that live in
      // code bodies are available from the structural baseline alone.
      if (results.length < limit) {
        const seen = new Set(results.filter((r) => r.type === 'file').map((r) => r.id));
        const extra = this.runContentSearch(projectId, query, type, limit)
          .filter((c) => !seen.has(c.id))
          .slice(0, limit - results.length);
        if (extra.length > 0) {
          results.push(...extra);
          diag.contentCount = extra.length;
        }
      }
      return cacheAndReturn({ results, diagnostics: diag });
    }

    if (mode === 'vector') {
      const results = await this.vectorSearchExpanded(projectId, projectName, query, type, limit, diag, options);
      if (results.length === 0 && diag.vectorError) {
        const fallback = await this.ftsSearch(projectId, query, type, limit);
        diag.ftsCount = fallback.length;
        diag.effectiveMode = 'fts';
        diag.fallback = true;
        diag.fallbackReason = diag.vectorError;
        return cacheAndReturn({ results: fallback, diagnostics: diag });
      }
      return cacheAndReturn({ results, diagnostics: diag });
    }

    // Hybrid has one canonical candidate-pipeline: lexical, vector, content,
    // recent and graph sources -> RRF -> reranker -> final top-K.
    const hybridDiag: SearchDiagnostics = { ...diag };
    const results = await this.searchViaPipeline(
      projectId,
      projectName,
      query,
      type,
      limit,
      overFetch,
      hybridDiag,
      true,
      options,
    );
    if (hybridDiag.vectorError) {
      hybridDiag.effectiveMode = 'fts';
      hybridDiag.fallback = true;
      hybridDiag.fallbackReason = hybridDiag.vectorError;
    }
    return cacheAndReturn({ results, diagnostics: hybridDiag });
  }

  /**
   * Content stream — MATCH over `file_contents_fts` (raw code text). The
   * lexical signal that still works on STRUCTURAL-only projects (files_fts
   * carries empty summaries there) and finds terms that live only in
   * function bodies. Same AND→OR fallback as ftsSearch. Synchronous; errors
   * (vtab missing on a pre-migration DB, malformed MATCH) degrade to [].
   * Kill switch: MCP_FTS_CONTENT_STREAM=0.
   */
  private runContentSearch(projectId: number, query: string, type: SearchType, limit: number): HybridSearchResult[] {
    if (process.env.MCP_FTS_CONTENT_STREAM === '0') return [];
    if (type === 'symbols') return [];
    try {
      const andQuery = this.sanitizeFtsQuery(query, 'AND');
      if (andQuery.length === 0) return [];
      let matches = this.db.searchFileContents(projectId, andQuery, limit);
      if (matches.length === 0 && ftsTokens(query).length > 1) {
        matches = this.db.searchFileContents(projectId, this.sanitizeFtsQuery(query, 'OR'), limit);
      }
      const out: HybridSearchResult[] = [];
      for (let i = 0; i < matches.length; i++) {
        const file = this.db.getFileById(matches[i].id, projectId);
        if (!file) continue;
        out.push({ id: file.id, type: 'file', score: 0, fts_rank: i + 1, vector_score: null, data: file });
      }
      return out;
    } catch {
      return [];
    }
  }

  private async ftsSearch(projectId: number, query: string, type: SearchType, limit: number): Promise<HybridSearchResult[]> {
    // Precision-first: require ALL terms (FTS5 AND). A multi-word query like
    // "user service create" should not match every doc mentioning just one of
    // them. If AND finds nothing, fall back to OR so a paraphrase that shares
    // only some terms is still recoverable (single-term queries are identical
    // either way, so the fallback is a no-op there).
    const results = this.runFtsQuery(projectId, query, type, limit, 'AND');
    if (results.length === 0 && ftsTokens(query).length > 1) {
      return this.runFtsQuery(projectId, query, type, limit, 'OR');
    }
    return results;
  }

  /** Run one FTS pass with a fixed boolean connector. */
  private runFtsQuery(
    projectId: number,
    query: string,
    type: SearchType,
    limit: number,
    connector: 'AND' | 'OR',
  ): HybridSearchResult[] {
    const results: HybridSearchResult[] = [];
    const ftsQuery = this.sanitizeFtsQuery(query, connector);
    if (ftsQuery.length === 0) return results;

    if (type === 'files' || type === 'all') {
      const files = this.db.searchFiles(projectId, ftsQuery, limit);
      for (let i = 0; i < files.length; i++) {
        results.push({
          id: files[i].id,
          type: 'file',
          score: 0,
          fts_rank: i + 1,
          vector_score: null,
          data: files[i],
        });
      }
    }

    if (type === 'symbols' || type === 'all') {
      const symbols = this.db.searchSymbols(projectId, ftsQuery, limit);
      for (let i = 0; i < symbols.length; i++) {
        results.push({
          id: symbols[i].id,
          type: 'symbol',
          score: 0,
          fts_rank: i + 1,
          vector_score: null,
          data: symbols[i],
        });
      }
    }

    // Files and symbols are queried independently, so `all` can otherwise
    // return up to `limit * 2`. The public contract is one top-K across the
    // merged result set.
    return results.slice(0, limit);
  }

  /** Search the original text and, when available, one generated code variant. */
  private async vectorSearchExpanded(
    projectId: number,
    projectName: string,
    query: string,
    type: SearchType,
    limit: number,
    diag: SearchDiagnostics,
    options?: HybridSearchOptions,
  ): Promise<HybridSearchResult[]> {
    options?.signal?.throwIfAborted();
    if (!codeSearchFolders(this.db, projectId).length) return [];
    const namespace = codeNamespace(projectId);
    const blocked = this.embeddingService.queryBlockReasonForNamespace?.(namespace) ?? null;
    if (blocked) {
      diag.vectorError = blocked;
      return [];
    }
    if (!this.vectorStore || this.embeddingService instanceof NullEmbeddingService) {
      diag.vectorError = !this.vectorStore
        ? 'No vector store configured'
        : 'No embedding service configured';
      return [];
    }

    try {
      const variants = await codeQueryVariants(this.db, projectId, projectName, query,
        options?.preExpanded ? null : this.hydeService, options?.signal);
      diag.queryVariants = variants;
      options?.signal?.throwIfAborted();

      // Project isolation rides on the namespace now; `type` stays a metadata
      // filter to pick files vs symbols within the project.
      const filter = codeVectorFilter(type);

      const perVariant = Math.max(limit, 10);
      let totalRawMatches = 0;

      // Run each variant in parallel
      const runs = await Promise.all(
        variants.map(async (v, index) => {
          const { vector, generationId } = await embedQueryForNamespace(this.embeddingService, namespace, v, {
            signal: options?.signal, supersessionKey: options?.supersessionKey ? `${options.supersessionKey}:embed:${index}` : undefined,
          });
          options?.signal?.throwIfAborted();
          if (diag.generationUsed !== undefined && diag.generationUsed !== generationId) {
            throw new Error(`query variants resolved different semantic generations (${diag.generationUsed}, ${generationId})`);
          }
          diag.generationUsed = generationId;
          if (vector.length === 0) return [];
          const matches = await this.vectorStore!.search(vector, {
            topK: perVariant,
            ...filter,
            namespace,
            generationId,
            signal: options?.signal,
          });
          options?.signal?.throwIfAborted();
          totalRawMatches += matches.length;
          return this.rehydrateVectorMatches(distinctCodeMatches(matches, type), projectId);
        }),
      );

      diag.vectorRawMatches = totalRawMatches;

      // RRF merge across variants
      const scoreMap = new Map<string, HybridSearchResult>();
      for (const runResults of runs) {
        for (let rank = 0; rank < runResults.length; rank++) {
          const r = runResults[rank];
          const key = `${r.type}:${r.id}`;
          const delta = 1 / (RRF_K + rank + 1);
          const existing = scoreMap.get(key);
          if (existing) {
            existing.score += delta;
            // Keep the best vector_score
            if (r.vector_score && (!existing.vector_score || r.vector_score > existing.vector_score)) {
              existing.vector_score = r.vector_score;
            }
          } else {
            scoreMap.set(key, { ...r, score: delta });
          }
        }
      }

      const results = Array.from(scoreMap.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      diag.vectorRehydrated = results.length;
      return results;
    } catch (err) {
      options?.signal?.throwIfAborted();
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[hybrid-search] Vector search failed:', msg);
      diag.vectorError = msg;
      return [];
    }
  }

  /** Rehydrate vector matches from SQLite within the current code scope. */
  private rehydrateVectorMatches(
    matches: Array<{ score: number; metadata: Record<string, string> }>,
    projectId: number,
  ): HybridSearchResult[] {
    const folders = codeSearchFolders(this.db, projectId);
    const results: HybridSearchResult[] = [];
    for (const match of matches) {
      const isFile = match.metadata.type === 'file';
      const refId = match.metadata.ref_id ? parseInt(match.metadata.ref_id, 10) : 0;
      if (!refId) continue;

      const data: DBFile | DBSymbol | undefined = isFile
        ? this.db.getFileById(refId, projectId)
        : this.db.getSymbolById(refId, projectId);
      if (!data) continue;

      const result: HybridSearchResult = {
        id: data.id,
        type: isFile ? 'file' : 'symbol',
        score: match.score,
        fts_rank: null,
        vector_score: match.score,
        data,
      };
      if (codeResultInScope(folders, result)) results.push(result);
    }
    return results;
  }

  /** Fuse hybrid result ranks from the original query and one optional HyDE reformulation. */
  async searchExpanded(
    projectId: number,
    projectName: string,
    query: string,
    options?: { type?: SearchType; limit?: number; signal?: AbortSignal; requireSemantic?: boolean | 'candidates' }
  ): Promise<HybridSearchResult[]> {
    const type = options?.type ?? 'all';
    const limit = options?.limit ?? 20;

    const variants = await codeQueryVariants(this.db, projectId, projectName, query, this.hydeService, options?.signal);

    const perVariant = Math.max(limit, 10);
    const runs = await Promise.all(
      variants.map(async v => {
        const { results, diagnostics } = await this.searchWithDiag(projectId, projectName, v, {
          mode: 'hybrid', type, limit: perVariant, preExpanded: true, signal: options?.signal, bypassCache: !!options?.requireSemantic,
        });
        if (options?.requireSemantic) verifySemanticRetrieval(diagnostics, options.requireSemantic === 'candidates');
        return results;
      })
    );

    // RRF merge across variants using the same K as rrfMerge.
    const scoreMap = new Map<string, HybridSearchResult>();
    for (const runResults of runs) {
      for (let rank = 0; rank < runResults.length; rank++) {
        const r = runResults[rank];
        const key = `${r.type}:${r.id}`;
        const delta = 1 / (RRF_K + rank + 1);
        const existing = scoreMap.get(key);
        if (existing) existing.score += delta;
        else scoreMap.set(key, { ...r, score: delta });
      }
    }

    return Array.from(scoreMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Hybrid snapshot search: FTS5 + vector RRF merge. Falls back cleanly to
   * FTS-only if embeddings aren't configured or vector search fails. Returns
   * deduplicated snapshots ordered by combined score.
   */
  async searchSnapshotsHybrid(
    projectId: number,
    projectName: string,
    query: string,
    limit: number
  ): Promise<ContextSnapshot[]> {
    const ftsSnaps = this.db.searchSnapshots(projectId, query);

    // Vector side: only runs if embeddings + vector store are available.
    let vectorSnaps: ContextSnapshot[] = [];
    if (this.vectorStore && !(this.memoryEmbeddingService instanceof NullEmbeddingService)) {
      try {
        const namespace = snapshotNamespace(projectId);
        if (this.memoryEmbeddingService.queryBlockReasonForNamespace?.(namespace)) {
          return ftsSnaps.slice(0, limit);
        }
        const { vector, generationId } = await embedQueryForNamespace(
          this.memoryEmbeddingService,
          namespace,
          query,
        );
        if (vector.length > 0) {
          // Snapshots are now chunked, so several matches can share a ref_id.
          // Over-fetch (×4) and keep the first (best-scored) chunk per
          // snapshot — dedup here keeps RRF ranks one-per-snapshot.
          // Snapshot vectors share the project's physical vectors.db but keep
          // their own ID-based namespace and active generation. Project names
          // are descriptive metadata only and may predate a rename.
          const matches = await this.vectorStore.search(vector, {
            topK: limit * 4,
            filter: { type: 'snapshot' },
            namespace,
            generationId,
          });
          const seen = new Set<number>();
          for (const m of matches) {
            const refId = m.metadata.ref_id ? parseInt(m.metadata.ref_id, 10) : 0;
            if (!refId || seen.has(refId)) continue;
            seen.add(refId);
            const snap = this.db.getSnapshotById(refId);
            // Archived snapshots have their vectors dropped, but a stale vector
            // could linger until the delete drains — filter defensively.
            if (snap && snap.project_id === projectId && !snap.archived_at) vectorSnaps.push(snap);
          }
        }
      } catch (err) {
        console.error('[snapshot-search] vector side failed:', (err as Error).message);
      }
    }

    if (vectorSnaps.length === 0) return ftsSnaps.slice(0, limit);

    // RRF merge — rank is position within each list.
    const scoreMap = new Map<number, { snap: ContextSnapshot; score: number }>();
    for (let rank = 0; rank < ftsSnaps.length; rank++) {
      const s = ftsSnaps[rank];
      const score = 1 / (RRF_K + rank + 1);
      scoreMap.set(s.id, { snap: s, score });
    }
    for (let rank = 0; rank < vectorSnaps.length; rank++) {
      const s = vectorSnaps[rank];
      const score = 1 / (RRF_K + rank + 1);
      const existing = scoreMap.get(s.id);
      if (existing) existing.score += score;
      else scoreMap.set(s.id, { snap: s, score });
    }

    const fused = Array.from(scoreMap.values()).sort((a, b) => b.score - a.score);
    if (this.memoryReranker.name !== 'null' && fused.length > 0) {
      const depth = Math.min(
        fused.length,
        this.memoryReranker.candidatePoolSize?.(limit) ?? Math.max(limit * 2, 20),
      );
      const candidates = fused.slice(0, depth);
      try {
        const reranked = await this.memoryReranker.rerank(
          query,
          candidates.map(({ snap, score }) => ({
            id: String(snap.id),
            text: `${snap.title}\n${snap.category}\n${snap.content}\n${snap.tags}`,
            originalScore: score,
          })),
          Math.min(limit, candidates.length),
        );
        const byId = new Map(candidates.map((entry) => [String(entry.snap.id), entry.snap]));
        const seen = new Set<string>();
        if (reranked.length !== Math.min(limit, candidates.length) || reranked.some((row) => {
          if (!byId.has(row.id) || seen.has(row.id) || !Number.isFinite(row.score)) return true;
          seen.add(row.id);
          return false;
        })) throw new Error(`${this.memoryReranker.name} returned an incomplete snapshot result set`);
        return reranked.map((row) => byId.get(row.id)!);
      } catch (err) {
        console.warn(`[snapshot-search] ${this.memoryReranker.name} rerank unavailable; preserving RRF order: ${
          err instanceof Error ? err.message : String(err)
        }`);
      }
    }

    return fused.slice(0, limit).map((entry) => entry.snap);
  }

  /**
   * Build an FTS5 MATCH expression. Defaults to AND (every term must appear)
   * for precision; callers fall back to OR when AND returns nothing so recall
   * is preserved. Single-term queries are identical under either connector.
   * Delegates to the canonical quote-per-token builder in @mcp/store.
   */
  private sanitizeFtsQuery(query: string, connector: 'AND' | 'OR' = 'AND'): string {
    return buildConceptFtsMatch(query, connector);
  }
}
