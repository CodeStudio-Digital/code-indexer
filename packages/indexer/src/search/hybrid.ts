import type { CodeIndexDB } from '@mcp/store/db.js';
import type { VectorStore } from '@mcp/store/vectors.js';
import { buildFtsMatch, ftsTokens } from '@mcp/store/db/fts-query.js';
import type { EmbeddingService } from '@mcp/indexer/search/embeddings.js';
import {
  embedQueryForNamespace,
  NullEmbeddingService,
} from '@mcp/indexer/search/embeddings.js';
import type { HyDEService } from '@mcp/indexer/search/hyde.js';
import type { RerankerService } from '@mcp/indexer/search/reranker.js';
import { planQuery } from '@mcp/indexer/search/planner.js';
import { NullReranker } from '@mcp/indexer/search/reranker.js';
import type { RecentFilesSource } from '@mcp/indexer/search/recent-files-source.js';
import type { HybridSearchResult, SearchMode, SearchType, DBFile, DBSymbol, ContextSnapshot } from '@mcp/shared/types.js';
import { codeNamespace, snapshotNamespace } from '@mcp/shared/vector-namespace.js';
import type { CandidatePipeline, TelemetrySink } from '@mcp/candidate-pipeline';
import {
  createHybridSearchPipeline,
  rerankDocumentText,
  runHybridSearchPipeline,
  type HybridSearchPipelineCandidate,
  type HybridSearchPipelineQuery,
} from '@mcp/indexer/search/hybrid-pipeline.js';

/** Diagnostic info returned alongside search results. */
export interface SearchDiagnostics {
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

/**
 * Build 2-3 query variants for pseudo-HyDE expansion. The template phrases
 * nudge the embedding model toward code-space rather than question-space,
 * which measurably improves recall for NL questions on code corpora.
 */
function buildQueryVariants(query: string): string[] {
  const trimmed = query.trim();
  const variants = new Set<string>();
  variants.add(trimmed);

  // Strip common interrogative prefixes to get the topic.
  const topic = trimmed
    .replace(/^(how\s+(?:does|do|is|are|can|to)|what\s+(?:is|does|are)|where\s+(?:is|does|are)|why\s+(?:is|does|are))\s+/i, '')
    .replace(/\?+\s*$/, '')
    .trim();

  if (topic && topic !== trimmed) {
    variants.add(`implementation of ${topic}`);
    variants.add(`function class ${topic}`);
  } else {
    variants.add(`${trimmed} implementation`);
  }

  return Array.from(variants).slice(0, 3);
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
  ) {
    this.reranker = reranker ?? new NullReranker();
    this.recentFilesSource = recentFilesSource ?? null;
    this.pipelineTelemetry = pipelineTelemetry ?? null;
    this.memoryEmbeddingService = memoryEmbeddingService ?? embeddingService;
    this.memoryReranker = memoryReranker ?? new NullReranker();
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
    requestOptions: Pick<HybridSearchOptions, 'supersessionKey' | 'signal'> = {},
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
      queryId: `hybrid:${projectId}:${query}:${type}:${limit}`,
      projectId,
      projectName,
      query,
      type,
      overFetch,
      limit,
      supersessionKey: requestOptions.supersessionKey,
      signal: requestOptions.signal,
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
    const requestedRerankDepth = this.reranker.candidatePoolSize?.(limit) ?? limit * 2;
    const rerankDepth = Math.max(limit, requestedRerankDepth);
    const gathered: GlobalHybridSearchResult[] = [];
    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (cursor < projects.length) {
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
    if (mode === 'hybrid' && candidates.length > 0 && this.reranker.name !== 'null') {
      const rerankInput = candidates.map((candidate) => ({
        id: `${candidate.projectId}:${candidate.result.type}:${candidate.result.id}`,
        text: rerankDocumentText(candidate.result, this.db, candidate.projectId),
        originalScore: candidate.result.score,
      }));
      try {
        const expected = Math.min(limit, rerankInput.length);
        const reranked = await this.reranker.rerank(query, rerankInput, expected, {
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
          throw new Error(`${this.reranker.name} returned an incomplete or invalid global result set`);
        }
        const byId = new Map(candidates.map((candidate) => [
          `${candidate.projectId}:${candidate.result.type}:${candidate.result.id}`,
          candidate,
        ]));
        finalCandidates = reranked.map((row) => {
          const candidate = byId.get(row.id)!;
          return {
            ...candidate,
            result: { ...candidate.result, score: row.score },
          };
        });
      } catch (error) {
        console.warn(`[hybrid-search] ${this.reranker.name} global rerank unavailable; preserving RRF order: ${
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
        ? this.reranker.cacheRevision?.() ?? 'legacy'
        : 'not-used';
      return JSON.stringify([
        projectId,
        query,
        mode,
        type,
        limit,
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

    // Check cache (key includes resolved mode so `auto` and `hybrid`
    // share a result row when the planner picks `hybrid`).
    const cacheKey = options?.bypassCache
      ? null
      : this.queryCacheKey(projectId, query, mode, type, limit);
    const cached = cacheKey ? this.queryCache.get(cacheKey) : undefined;
    if (cached && Date.now() - cached.ts < this.queryCacheTtlMs) {
      // Return the diagnostics of the run that produced the entry — a
      // stripped object here made consumers (e.g. the agent-facing
      // diagnostics trailer) report "all fine" on cache hits even when the
      // cached run had degraded to FTS-only.
      return {
        results: cached.results,
        diagnostics: {
          ...cached.diagnostics,
          cacheHit: true,
          totalTimeMs: performance.now() - startedAt,
        },
      };
    }

    const diag: SearchDiagnostics = {
      vectorAvailable: !!this.vectorStore,
      embeddingAvailable: !(this.embeddingService instanceof NullEmbeddingService),
      requestedMode,
      plannedMode: mode,
      effectiveMode: mode,
      cacheHit: false,
      ...(mode !== 'fts'
        ? { embedder: this.embeddingService.cacheRevisionForNamespace?.(codeNamespace(projectId))
            ?? this.embeddingService.fingerprint?.()
            ?? 'unknown' }
        : {}),
      ...(mode === 'hybrid'
        ? { reranker: this.reranker.cacheRevision?.() ?? this.reranker.name }
        : {}),
      ...(plannerReason ? { plannerMode: mode, plannerReason } : {}),
    };

    const cacheAndReturn = (r: { results: HybridSearchResult[]; diagnostics: SearchDiagnostics }) => {
      r.diagnostics.totalTimeMs = performance.now() - startedAt;
      // A transient semantic failure must not pin an FTS-only fallback for the
      // full cache TTL. No-active/disabled namespace-aware services surface
      // through vectorError as well, and their revision changes when serving
      // becomes available again.
      const degradedSemanticResult = mode !== 'fts'
        && (!!r.diagnostics.vectorError || r.diagnostics.fallback === true);
      if (cacheKey && !degradedSemanticResult) {
        // Evict oldest if full
        if (this.queryCache.size >= this.queryCacheMax) {
          const oldest = [...this.queryCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
          if (oldest) this.queryCache.delete(oldest[0]);
        }
        this.queryCache.set(cacheKey, { results: r.results, diagnostics: r.diagnostics, ts: Date.now() });
      }
      return r;
    };

    if (mode === 'fts') {
      const results = await this.ftsSearch(projectId, query, type, limit);
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
      const results = await this.vectorSearchExpanded(projectId, projectName, query, type, limit, diag);
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

    return results;
  }

  /**
   * Vector search with multi-query expansion and diagnostics.
   *
   * NL queries like "how create tools" don't match code embeddings well.
   * We expand the query into 2-3 variants (e.g. "implementation of create tools",
   * "function class create tools") and RRF-merge the per-variant results.
   * If a HyDE service is available, we also include a synthetic code snippet.
   */
  private async vectorSearchExpanded(
    projectId: number,
    projectName: string,
    query: string,
    type: SearchType,
    limit: number,
    diag: SearchDiagnostics,
  ): Promise<HybridSearchResult[]> {
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
      // Build query variants for better NL→code recall.
      // Identifier-shaped queries gain nothing from HyDE — the LLM call adds
      // 200-400ms and the synthetic snippet drifts away from exact-name
      // matching — so when the planner classifies the query as fts-shaped,
      // embed only the raw query. Kill switch: MCP_HYBRID_HYDE_SKIP_FTS=0.
      const skipExpansion = process.env.MCP_HYBRID_HYDE_SKIP_FTS !== '0'
        && planQuery(query).mode === 'fts';
      let variants: string[];
      if (skipExpansion) {
        variants = [query.trim()];
      } else if (this.hydeService) {
        const hypothetical = await this.hydeService.generate(query);
        variants =
          hypothetical && hypothetical !== query
            ? [query, hypothetical]
            : buildQueryVariants(query);
      } else {
        variants = buildQueryVariants(query);
      }
      diag.queryVariants = variants;

      // Project isolation rides on the namespace now; `type` stays a metadata
      // filter to pick files vs symbols within the project.
      const filter: Record<string, string> = {};
      if (type === 'files') filter.type = 'file';
      // Do not filter symbol queries to metadata.type='symbol': body and
      // sibling-group vectors carry the same structural ref_id and must be
      // eligible for semantic_neighbors and natural-language symbol search.

      const perVariant = Math.max(limit, 10);
      let totalRawMatches = 0;

      // Run each variant in parallel
      const runs = await Promise.all(
        variants.map(async (v) => {
          const { vector, generationId } = await embedQueryForNamespace(this.embeddingService, namespace, v);
          if (vector.length === 0) return [];
          const matches = await this.vectorStore!.search(vector, {
            topK: perVariant,
            filter,
            namespace,
            generationId,
          });
          totalRawMatches += matches.length;
          return this.rehydrateVectorMatches(matches, projectId);
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
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[hybrid-search] Vector search failed:', msg);
      diag.vectorError = msg;
      return [];
    }
  }

  /** Rehydrate vector matches from SQLite — shared by vectorSearchExpanded and snapshot search. */
  private rehydrateVectorMatches(
    matches: Array<{ score: number; metadata: Record<string, string> }>,
    projectId?: number,
  ): HybridSearchResult[] {
    const results: HybridSearchResult[] = [];
    for (const match of matches) {
      const isFile = match.metadata.type === 'file';
      const refId = match.metadata.ref_id ? parseInt(match.metadata.ref_id, 10) : 0;
      if (!refId) continue;

      const data: DBFile | DBSymbol | undefined = isFile
        ? this.db.getFileById(refId, projectId)
        : this.db.getSymbolById(refId, projectId);
      if (!data) continue;

      results.push({
        id: data.id,
        type: isFile ? 'file' : 'symbol',
        score: match.score,
        fts_rank: null,
        vector_score: match.score,
        data,
      });
    }
    return results;
  }

  /**
   * Query expansion for NL questions. Two modes:
   *
   *   1. **Real HyDE (when hydeService is provided)** — calls an LLM to draft
   *      a short hypothetical code snippet / docstring that would answer the
   *      query, then uses BOTH the raw query and the synthetic snippet as
   *      variants. Adds ~200-400ms of latency but dramatically improves
   *      recall for questions the codebase never phrases the same way.
   *
   *   2. **Template-based (fallback)** — rewrites `how does X work?` into
   *      `implementation of X` and `function class X`. Deterministic and
   *      free. Ships when no HyDE service is wired in the tool context.
   *
   * In both cases we run the hybrid search once per variant and RRF-merge
   * the results. Scores are normalized to each variant's rank so the raw
   * query doesn't dominate a strong HyDE match.
   */
  async searchExpanded(
    projectId: number,
    projectName: string,
    query: string,
    options?: { type?: SearchType; limit?: number }
  ): Promise<HybridSearchResult[]> {
    const type = options?.type ?? 'all';
    const limit = options?.limit ?? 20;

    // Real HyDE takes precedence when available; we still include the raw
    // query so exact-token matches aren't lost.
    let variants: string[];
    if (this.hydeService) {
      const hypothetical = await this.hydeService.generate(query);
      variants =
        hypothetical && hypothetical !== query
          ? [query, hypothetical]
          : buildQueryVariants(query);
    } else {
      variants = buildQueryVariants(query);
    }

    const perVariant = Math.max(limit, 10);
    const runs = await Promise.all(
      variants.map((v) => this.search(projectId, projectName, v, { mode: 'hybrid', type, limit: perVariant }))
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
    return buildFtsMatch(query, connector);
  }
}
