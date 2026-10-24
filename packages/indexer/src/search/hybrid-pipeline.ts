/**
 * HybridSearchPipeline: `HybridSearch.search()` built on the
 * `@mcp/candidate-pipeline` framework.
 *
 * candidate framework with one observable production path.
 *
 * This is the production hybrid-search path. There is intentionally no
 * feature-flagged legacy branch: every consumer gets the same fusion,
 * reranking, diagnostics and fail-open behavior.
 *
 * **Stage map**:
 *
 *   Source        ── FtsSource         (FTS5 — sb_symbols + files)
 *                 ── VectorSource      (vector + HyDE variants + RRF across them)
 *                 ── ContentSource     (raw structural source-code FTS)
 *                 ── RecentFilesSource (when a hot-cache source is wired)
 *                 ── GraphSource       (one-hop references/dependencies)
 *
 *   Scorer        ── RrfFusionScorer   (canonical K=60 across all sources)
 *
 *   PostScoreFilt ── DedupFilter    (after RRF, before selection)
 *
 *   Selector      ── TopKSelector  (expanded rerank depth)
 *
 *   PostSelHydr.  ── RerankerHydrator  (cross-encoder on expanded set)
 *   PostSelSelect ── TopKSelector  (reranked final result count)
 *
 *   SideEffect    ── CacheWriteSink    (populates the LRU cache for next call)
 *                 ── TelemetryEmitSink (via the CandidatePipeline's built-in
 *                                       per-stage emit — automatic when
 *                                       `telemetry` is wired)
 *
 * **RRF parity**: each Source records the candidate's rank in its own
 * output list. The RrfFusionScorer reads those ranks and applies
 * `1 / (K + rank)` with K=60, matching the canonical scorer helper.
 */
import {
  CandidatePipeline,
  TopKSelector,
  type Filter,
  type Hydrator,
  type PipelineCandidate,
  type PipelineQuery,
  type Scorer,
  type SideEffect,
  type Source,
  type TelemetrySink,
} from '@mcp/candidate-pipeline';
import { open } from 'node:fs/promises';
import { mapLimit } from '@mcp/shared/utils/map-limit.js';
import { isAbsolute, relative, resolve } from 'node:path';
import { rrfMerge as cpRrfMerge, RRF_DEFAULT_K } from '@mcp/candidate-pipeline/scorers/rrf.js';
import { codeNamespace } from '@mcp/shared/vector-namespace.js';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { VectorStore } from '@mcp/store/vectors.js';
import type { EmbeddingService } from '@mcp/indexer/search/embeddings.js';
import {
  embedQueryForNamespace,
  NullEmbeddingService,
} from '@mcp/indexer/search/embeddings.js';
import type { HyDEService } from '@mcp/indexer/search/hyde.js';
import { planQuery } from '@mcp/indexer/search/planner.js';
import type { RerankerService } from '@mcp/indexer/search/reranker.js';
import { NullReranker } from '@mcp/indexer/search/reranker.js';
import type { RecentFilesSource } from '@mcp/indexer/search/recent-files-source.js';
import { expandGraph } from '@mcp/indexer/search/graph-expansion-source.js';
import type {
  ContextSnapshot,
  DBFile,
  DBSymbol,
  HybridSearchResult,
  SearchType,
} from '@mcp/shared/types.js';

const RRF_K = RRF_DEFAULT_K; // 60

function rerankDepth(q: HybridSearchPipelineQuery, reranker: RerankerService): number {
  const configured = Number.parseInt(process.env.MCP_RERANK_DEPTH ?? '', 10);
  const requested = Number.isFinite(configured) && configured > 0
    ? configured
    : reranker.candidatePoolSize?.(q.limit) ?? q.limit * 2;
  // A low environment override must never truncate below the public result
  // count. The candidate array itself naturally caps this value.
  return Math.max(q.limit, requested);
}

// ─── Query and Candidate types ────────────────────────────────────────

export interface HybridSearchPipelineQuery extends PipelineQuery {
  projectId: number;
  projectName: string;
  query: string;
  type: SearchType;
  /** Over-fetch factor — each source fetches `limit * 3` to feed the RRF. */
  overFetch: number;
  /** Final result count to return after selection + reranking. */
  limit: number;
  /** Stable latest-wins key for interactive callers such as Search Everywhere. */
  supersessionKey?: string;
  /** Request-lifecycle cancellation. Sources may finish, but reranking is skipped. */
  signal?: AbortSignal;
  /**
   * Diagnostic accumulator. Each stage may append/overwrite fields
   * here for downstream observers. The wrapping `HybridSearch.search()`
   * reads this back to build the user-facing `SearchDiagnostics`.
   */
  diag: {
    ftsCount?: number;
    vectorRawMatches?: number;
    vectorRehydrated?: number;
    vectorError?: string;
    queryVariants?: string[];
    recentFilesCount?: number;
    contentCount?: number;
    graphExpansionCount?: number;
    generationUsed?: number;
    rerankerApplied?: boolean;
    rerankerCandidates?: number;
    rerankerReturned?: number;
    rerankerError?: string;
  };
}

export interface HybridSearchPipelineCandidate extends PipelineCandidate {
  /** The hybrid result row eventually returned to the caller. */
  result: HybridSearchResult;
  /** Per-source rank — set by each source for its own emissions. */
  ranks: {
    fts?: number; // 1-indexed
    vector?: number; // 1-indexed
    recent?: number; // 1-indexed
    content?: number; // 1-indexed
    graph?: number; // 1-indexed
  };
  /** Final RRF score. Set by RrfFusionScorer. */
  score: number;
}

// ─── Helper: build candidate identity ─────────────────────────────────

function candidateKey(r: HybridSearchResult): string {
  return `${r.type}:${r.id}`;
}

function emptyCandidate(r: HybridSearchResult): HybridSearchPipelineCandidate {
  return {
    candidateId: candidateKey(r),
    result: r,
    ranks: {},
    score: 0,
  };
}

// ─── Sources ──────────────────────────────────────────────────────────

interface RawSearchInputs {
  db: CodeIndexDB;
  vectorStore: VectorStore | null;
  embeddingService: EmbeddingService;
  hyde: HyDEService | null;
  recentFilesSource: RecentFilesSource | null;
  /**
   * Reuse the legacy method's FTS sanitization to keep parity. Takes a
   * boolean connector so the source can run AND-first (precision) then fall
   * back to OR (recall) — mirroring `HybridSearch.ftsSearch`.
   */
  ftsSanitize: (q: string, connector: 'AND' | 'OR') => string;
}

export function semanticProjectContext(
  db: CodeIndexDB,
  projectId: number,
  projectName: string,
): { language?: string; concepts?: string[] } {
  try {
    const languages = db.getStats(projectId).languages;
    const language = Object.entries(languages)
      .sort((left, right) => right[1] - left[1])[0]?.[0];
    const project = db.getProject(projectId);
    const descriptionTerms = (project?.description ?? '')
      .split(/[,\s;/]+/)
      .map((term) => term.trim())
      .filter((term) => term.length >= 4)
      .slice(0, 7);
    return {
      language,
      concepts: [projectName, ...descriptionTerms].slice(0, 8),
    };
  } catch {
    return { concepts: [projectName] };
  }
}

export class FtsSource implements Source<HybridSearchPipelineQuery, HybridSearchPipelineCandidate> {
  readonly name = 'fts';
  constructor(private deps: RawSearchInputs) {}

  enable(): boolean {
    return true;
  }

  async source(q: HybridSearchPipelineQuery): Promise<HybridSearchPipelineCandidate[]> {
    // Precision-first (AND); widen to OR only when AND finds nothing — mirrors
    // HybridSearch.ftsSearch so the V2 path stays consistent with legacy.
    const andQuery = this.deps.ftsSanitize(q.query, 'AND');
    let results = this.runFts(q, andQuery);
    if (results.length === 0) {
      const orQuery = this.deps.ftsSanitize(q.query, 'OR');
      if (orQuery !== andQuery) results = this.runFts(q, orQuery);
    }
    q.diag.ftsCount = results.length;
    return results;
  }

  private runFts(q: HybridSearchPipelineQuery, ftsQuery: string): HybridSearchPipelineCandidate[] {
    const results: HybridSearchPipelineCandidate[] = [];
    if (ftsQuery.length === 0) return results;

    if (q.type === 'files' || q.type === 'all') {
      const files = this.deps.db.searchFiles(q.projectId, ftsQuery, q.overFetch);
      for (let i = 0; i < files.length; i++) {
        const r: HybridSearchResult = {
          id: files[i].id,
          type: 'file',
          score: 0,
          fts_rank: i + 1,
          vector_score: null,
          data: files[i],
        };
        const c = emptyCandidate(r);
        c.ranks.fts = i + 1;
        results.push(c);
      }
    }
    if (q.type === 'symbols' || q.type === 'all') {
      const symbols = this.deps.db.searchSymbols(q.projectId, ftsQuery, q.overFetch);
      for (let i = 0; i < symbols.length; i++) {
        const r: HybridSearchResult = {
          id: symbols[i].id,
          type: 'symbol',
          score: 0,
          fts_rank: i + 1,
          vector_score: null,
          data: symbols[i],
        };
        const c = emptyCandidate(r);
        c.ranks.fts = i + 1;
        results.push(c);
      }
    }
    return results;
  }
}

export class VectorSource implements Source<HybridSearchPipelineQuery, HybridSearchPipelineCandidate> {
  readonly name = 'vector';
  constructor(private deps: RawSearchInputs) {}

  enable(q: HybridSearchPipelineQuery): boolean {
    // Skip vector when embeddings/vector store missing — degrade gracefully
    // to FTS-only. Mirrors the legacy `vectorSearchExpanded` early return.
    const blocked = this.deps.embeddingService.queryBlockReasonForNamespace?.(
      codeNamespace(q.projectId),
    ) ?? null;
    if (blocked) {
      q.diag.vectorError = blocked;
      return false;
    }
    return !!this.deps.vectorStore && !(this.deps.embeddingService instanceof NullEmbeddingService);
  }

  async source(q: HybridSearchPipelineQuery): Promise<HybridSearchPipelineCandidate[]> {
    if (!this.deps.vectorStore) return [];
    try {
      const variants = await this.buildVariants(q);
      q.diag.queryVariants = variants;

      // Project isolation rides on the namespace; `type` stays a metadata filter.
      const namespace = codeNamespace(q.projectId);
      const filter: Record<string, string> = {};
      if (q.type === 'files') filter.type = 'file';
      // Symbol search must include signature, body and sibling-group vectors.
      // They all rehydrate through ref_id to the owning structural symbol.

      const perVariant = Math.max(q.overFetch, 10);
      let totalRaw = 0;
      const variantResults: HybridSearchPipelineCandidate[][] = await Promise.all(
        variants.map(async (v, index) => {
          const { vector, generationId } = await embedQueryForNamespace(
            this.deps.embeddingService,
            namespace,
            v,
            { signal: q.signal, supersessionKey: q.supersessionKey ? `${q.supersessionKey}:embed:${index}` : undefined },
          );
          if (q.diag.generationUsed !== undefined && q.diag.generationUsed !== generationId) {
            throw new Error(`query variants resolved different semantic generations (${q.diag.generationUsed}, ${generationId})`);
          }
          q.diag.generationUsed = generationId;
          if (vector.length === 0) return [];
          const matches = await this.deps.vectorStore!.search(vector, {
            topK: perVariant,
            filter,
            namespace,
            generationId,
          });
          totalRaw += matches.length;
          return this.rehydrate(matches, q.projectId);
        }),
      );
      q.diag.vectorRawMatches = totalRaw;

      // RRF across variants using the canonical helper — keeps parity
      // with the legacy `vectorSearchExpanded` per-variant fusion.
      const rankableLists = variantResults.map((items) => ({
        items: items.map((c) => ({ candidateId: c.candidateId })),
      }));
      const merged = cpRrfMerge(rankableLists, { k: RRF_K, limit: q.overFetch });

      // Reconstruct candidates in the merged order; preserve best vector_score
      const candidateByKey = new Map<string, HybridSearchPipelineCandidate>();
      for (const runResults of variantResults) {
        for (const c of runResults) {
          const existing = candidateByKey.get(c.candidateId);
          if (!existing) {
            candidateByKey.set(c.candidateId, c);
          } else if (
            c.result.vector_score !== null &&
            (existing.result.vector_score === null ||
              c.result.vector_score > existing.result.vector_score)
          ) {
            existing.result.vector_score = c.result.vector_score;
          }
        }
      }

      const orderedResults: HybridSearchPipelineCandidate[] = [];
      for (let i = 0; i < merged.length; i++) {
        const c = candidateByKey.get(merged[i].candidateId);
        if (!c) continue;
        c.ranks.vector = i + 1;
        orderedResults.push(c);
      }
      q.diag.vectorRehydrated = orderedResults.length;
      return orderedResults;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[hybrid-pipeline] vector source failed:', msg);
      q.diag.vectorError = msg;
      return [];
    }
  }

  private async buildVariants(q: HybridSearchPipelineQuery): Promise<string[]> {
    const query = q.query;
    // Same shortcut as the legacy path: identifier-shaped queries skip the
    // HyDE LLM call and template expansion (covers callers that request
    // hybrid explicitly). Kill switch: MCP_HYBRID_HYDE_SKIP_FTS=0.
    if (process.env.MCP_HYBRID_HYDE_SKIP_FTS !== '0' && planQuery(query).mode === 'fts') {
      return [query.trim()];
    }
    if (this.deps.hyde) {
      const hypothetical = await this.deps.hyde.generate(
        query,
        semanticProjectContext(
          this.deps.db,
          q.projectId,
          q.projectName,
        ),
      );
      if (hypothetical && hypothetical !== query) return [query, hypothetical];
    }
    return buildTemplateVariants(query);
  }

  private rehydrate(
    matches: Array<{ score: number; metadata: Record<string, string> }>,
    projectId?: number,
  ): HybridSearchPipelineCandidate[] {
    const out: HybridSearchPipelineCandidate[] = [];
    for (const match of matches) {
      const isFile = match.metadata.type === 'file';
      const refId = match.metadata.ref_id ? parseInt(match.metadata.ref_id, 10) : 0;
      if (!refId) continue;
      const data: DBFile | DBSymbol | undefined = isFile
        ? this.deps.db.getFileById(refId, projectId)
        : this.deps.db.getSymbolById(refId, projectId);
      if (!data) continue;
      const r: HybridSearchResult = {
        id: data.id,
        type: isFile ? 'file' : 'symbol',
        score: match.score,
        fts_rank: null,
        vector_score: match.score,
        data,
      };
      out.push(emptyCandidate(r));
    }
    return out;
  }
}

export class RecentFilesSourceStage
  implements Source<HybridSearchPipelineQuery, HybridSearchPipelineCandidate>
{
  readonly name = 'recent';
  constructor(private deps: { db: CodeIndexDB; recent: RecentFilesSource | null }) {}

  enable(q: HybridSearchPipelineQuery): boolean {
    return !!this.deps.recent && q.type !== 'symbols';
  }

  async source(q: HybridSearchPipelineQuery): Promise<HybridSearchPipelineCandidate[]> {
    if (!this.deps.recent) return [];
    const matches = this.deps.recent.match(q.projectId, q.query, Math.max(5, q.limit));
    const out: HybridSearchPipelineCandidate[] = [];
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      const data = m.fileId == null
        ? this.deps.db.getFile(q.projectId, m.filePath)
        : this.deps.db.getFileById(m.fileId, q.projectId);
      if (!data || data.project_id !== q.projectId) continue;
      const r: HybridSearchResult = {
        id: data.id,
        type: 'file',
        score: m.score,
        fts_rank: null,
        vector_score: null,
        data,
      };
      const c = emptyCandidate(r);
      c.ranks.recent = i + 1;
      out.push(c);
    }
    q.diag.recentFilesCount = out.length;
    return out;
  }
}

/** Raw source-code FTS. Unlike the legacy files FTS table, this stream is
 * populated by the structural index and therefore remains useful before any
 * semantic generation exists. */
export class ContentSource
  implements Source<HybridSearchPipelineQuery, HybridSearchPipelineCandidate>
{
  readonly name = 'content';
  constructor(private deps: Pick<RawSearchInputs, 'db' | 'ftsSanitize'>) {}

  enable(q: HybridSearchPipelineQuery): boolean {
    return process.env.MCP_FTS_CONTENT_STREAM !== '0' && q.type !== 'symbols';
  }

  async source(q: HybridSearchPipelineQuery): Promise<HybridSearchPipelineCandidate[]> {
    try {
      const andQuery = this.deps.ftsSanitize(q.query, 'AND');
      if (!andQuery) return [];
      let matches = this.deps.db.searchFileContents(q.projectId, andQuery, q.overFetch);
      if (matches.length === 0) {
        const orQuery = this.deps.ftsSanitize(q.query, 'OR');
        if (orQuery !== andQuery) {
          matches = this.deps.db.searchFileContents(q.projectId, orQuery, q.overFetch);
        }
      }
      const out: HybridSearchPipelineCandidate[] = [];
      for (let index = 0; index < matches.length; index++) {
        const file = this.deps.db.getFileById(matches[index].id, q.projectId);
        if (!file) continue;
        const candidate = emptyCandidate({
          id: file.id,
          type: 'file',
          score: 0,
          fts_rank: null,
          vector_score: null,
          data: file,
        });
        candidate.ranks.content = index + 1;
        out.push(candidate);
      }
      q.diag.contentCount = out.length;
      return out;
    } catch {
      return [];
    }
  }
}

/** One-hop structural expansion. The stage derives a small lexical seed set
 * itself because candidate-pipeline sources fan out concurrently; the final
 * scorer still performs one canonical RRF merge across all streams. */
export class GraphSource
  implements Source<HybridSearchPipelineQuery, HybridSearchPipelineCandidate>
{
  readonly name = 'graph';
  constructor(private deps: Pick<RawSearchInputs, 'db' | 'ftsSanitize'>) {}

  enable(q: HybridSearchPipelineQuery): boolean {
    return process.env.MCP_PIPELINES_GRAPH_EXPANSION !== '0' && q.type !== 'symbols';
  }

  async source(q: HybridSearchPipelineQuery): Promise<HybridSearchPipelineCandidate[]> {
    try {
      const match = this.deps.ftsSanitize(q.query, 'AND');
      if (!match) return [];
      const seeds: HybridSearchResult[] = [];
      for (const file of this.deps.db.searchFiles(q.projectId, match, 5)) {
        seeds.push({ id: file.id, type: 'file', score: 0, fts_rank: null, vector_score: null, data: file });
      }
      for (const symbol of this.deps.db.searchSymbols(q.projectId, match, 5)) {
        seeds.push({ id: symbol.id, type: 'symbol', score: 0, fts_rank: null, vector_score: null, data: symbol });
      }
      const expanded = expandGraph(this.deps.db, q.projectId, seeds, q.type, {
        maxResults: Math.min(q.overFetch, 20),
      });
      const out = expanded.map((result, index) => {
        const candidate = emptyCandidate(result);
        candidate.ranks.graph = index + 1;
        return candidate;
      });
      q.diag.graphExpansionCount = out.length;
      return out;
    } catch {
      return [];
    }
  }
}

// ─── Scorer: RRF fusion ──────────────────────────────────────────────

export class RrfFusionScorer
  implements Scorer<HybridSearchPipelineQuery, HybridSearchPipelineCandidate>
{
  readonly name = 'rrf_fusion';

  enable(): boolean {
    return true;
  }

  async score(
    _q: HybridSearchPipelineQuery,
    candidates: readonly HybridSearchPipelineCandidate[],
  ): Promise<Array<{ ok: true; candidate: HybridSearchPipelineCandidate }>> {
    // Sources fan-out in parallel, so the same candidateId may appear
    // multiple times in `candidates`. Group by candidateId, sum the RRF
    // contributions from each source, preserve best per-source metadata.
    type Acc = HybridSearchPipelineCandidate & { _summedFromIds: Set<string> };
    const byKey = new Map<string, Acc>();
    for (const c of candidates) {
      const existing = byKey.get(c.candidateId);
      if (!existing) {
        byKey.set(c.candidateId, { ...c, _summedFromIds: new Set() });
      } else {
        existing.ranks = {
          fts: existing.ranks.fts ?? c.ranks.fts,
          vector: existing.ranks.vector ?? c.ranks.vector,
          recent: existing.ranks.recent ?? c.ranks.recent,
          content: existing.ranks.content ?? c.ranks.content,
          graph: existing.ranks.graph ?? c.ranks.graph,
        };
        // Preserve best vector_score for diagnostics
        if (
          c.result.vector_score !== null &&
          (existing.result.vector_score === null ||
            c.result.vector_score > existing.result.vector_score)
        ) {
          existing.result.vector_score = c.result.vector_score;
        }
        if (c.result.fts_rank !== null && existing.result.fts_rank === null) {
          existing.result.fts_rank = c.result.fts_rank;
        }
      }
    }

    // Compute RRF score per candidate. NOTE: candidates is the ORDER
    // the framework gave us — we return the SAME length/order array
    // (per the Scorer contract), but the result-side score is the
    // fused RRF. Duplicates across sources end up with identical
    // scores in their respective rows (the selector will dedup later).
    const fusedByKey = new Map<string, number>();
    for (const acc of byKey.values()) {
      let s = 0;
      if (acc.ranks.fts !== undefined) s += 1 / (RRF_K + acc.ranks.fts);
      if (acc.ranks.vector !== undefined) s += 1 / (RRF_K + acc.ranks.vector);
      if (acc.ranks.recent !== undefined) s += 1 / (RRF_K + acc.ranks.recent);
      if (acc.ranks.content !== undefined) s += 1 / (RRF_K + acc.ranks.content);
      if (acc.ranks.graph !== undefined) s += 1 / (RRF_K + acc.ranks.graph);
      fusedByKey.set(acc.candidateId, s);
    }

    return candidates.map((c) => ({
      ok: true as const,
      candidate: {
        ...c,
        score: fusedByKey.get(c.candidateId) ?? 0,
        ranks: byKey.get(c.candidateId)?.ranks ?? c.ranks,
        result: {
          ...c.result,
          score: fusedByKey.get(c.candidateId) ?? 0,
          fts_rank: byKey.get(c.candidateId)?.result.fts_rank ?? c.result.fts_rank,
          vector_score: byKey.get(c.candidateId)?.result.vector_score ?? c.result.vector_score,
        },
      },
    }));
  }

  update(candidate: HybridSearchPipelineCandidate, scored: HybridSearchPipelineCandidate): void {
    candidate.score = scored.score;
    candidate.result = scored.result;
    candidate.ranks = scored.ranks;
  }
}

// ─── Post-score filter + post-selection reranker ─────────────────────

/**
 * Deduplicates candidates by `candidateId` (sources fan-out can produce
 * the same row from FTS and vector; the scorer summed their RRF
 * contributions but `candidates` still contains duplicates). Runs
 * BEFORE the reranker so the cross-encoder sees each row once.
 *
 * Post-scoring rather than a normal pre-score filter so every source rank
 * contributes to RRF. It still runs before selection, so duplicate rows do
 * not consume rerank depth or the public top-K.
 */
export class DedupFilter implements Filter<HybridSearchPipelineQuery, HybridSearchPipelineCandidate> {
  readonly name = 'dedup';
  enable(): boolean {
    return true;
  }
  filter(
    _q: HybridSearchPipelineQuery,
    candidates: HybridSearchPipelineCandidate[],
  ): { kept: HybridSearchPipelineCandidate[]; removed: HybridSearchPipelineCandidate[] } {
    const seen = new Set<string>();
    const kept: HybridSearchPipelineCandidate[] = [];
    const removed: HybridSearchPipelineCandidate[] = [];
    for (const c of candidates) {
      if (seen.has(c.candidateId)) {
        removed.push(c);
      } else {
        seen.add(c.candidateId);
        kept.push(c);
      }
    }
    return { kept, removed };
  }
}

const MAX_RERANK_SOURCE_CHARS = 8_000;

async function sourceText(db: CodeIndexDB, projectId: number, filePath: string, budget: { bytes: number }, signal?: AbortSignal): Promise<string[]> {
  try {
    if (signal?.aborted) return [];
    const root = db.getProject(projectId)?.root_path;
    if (!root) return [];
    const rootAbs = resolve(root);
    const fileAbs = resolve(rootAbs, filePath);
    const fromRoot = relative(rootAbs, fileAbs);
    if (!fromRoot || fromRoot.startsWith('..') || isAbsolute(fromRoot)) return [];
    const file = await open(fileAbs, 'r');
    try {
      // Bound both allocation and I/O, even if the source grows after stat.
      const maxBytes = 2 * 1024 * 1024;
      const stats = await file.stat();
      if (!stats.isFile() || stats.size > maxBytes || stats.size > budget.bytes || signal?.aborted) return [];
      budget.bytes -= stats.size;
      const buffer = Buffer.alloc(Math.min(maxBytes, stats.size));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      return signal?.aborted ? [] : buffer.toString('utf8', 0, bytesRead).split(/\r?\n/);
    } finally { await file.close(); }
  } catch {
    return [];
  }
}

/** Build cross-encoder documents from durable structural facts and source
 * text. This intentionally ignores the retired LLM summary/concepts fields. */
export function rerankDocumentText(
  result: HybridSearchResult,
  db?: CodeIndexDB,
  projectId?: number,
  sourceCache?: Map<string, string[]>,
): string {
  const data = result.data as unknown as Record<string, unknown>;
  const filePath = String(result.type === 'file' ? data.path ?? '' : data.file_path ?? '');
  const structural = result.type === 'file'
    ? db && projectId !== undefined
      ? (() => {
          try {
            return db.getSymbolsByFile(projectId, filePath)
              .slice(0, 48)
              .map((symbol) => [
                `${symbol.kind} ${symbol.name}`,
                symbol.signature,
                symbol.comment,
              ].filter(Boolean).join(' — '))
              .join('\n');
          } catch {
            return '';
          }
        })()
      : ''
    : [
        `${String(data.kind ?? 'symbol')} ${String(data.name ?? '')}`,
        String(data.signature ?? ''),
        String(data.comment ?? ''),
      ].filter(Boolean).join('\n');

  let snippet = '';
  const lines = sourceCache?.get(filePath) ?? [];
  if (result.type === 'symbol') {
    const start = Math.max(0, Number(data.line ?? 1) - 1);
    const end = Math.min(lines.length, start + 200, Math.max(start + 1, Number(data.end_line ?? start + 80)));
    snippet = lines.slice(start, end).join('\n');
  } else snippet = lines.slice(0, 200).join('\n');

  return [
    `Path: ${filePath}`,
    result.type === 'file' && data.language ? `Language: ${String(data.language)}` : '',
    structural ? `Structural skeleton:\n${structural}` : '',
    snippet ? `Source:\n${snippet}` : '',
  ].filter(Boolean).join('\n').slice(0, MAX_RERANK_SOURCE_CHARS);
}

export class RerankerHydrator
  implements Hydrator<HybridSearchPipelineQuery, HybridSearchPipelineCandidate>
{
  readonly name = 'reranker';
  constructor(private reranker: RerankerService, private db?: CodeIndexDB) {}

  enable(): boolean {
    return !(this.reranker instanceof NullReranker);
  }

  async hydrate(
    q: HybridSearchPipelineQuery,
    candidates: readonly HybridSearchPipelineCandidate[],
  ): Promise<Array<{ ok: true; candidate: HybridSearchPipelineCandidate }>> {
    q.diag.rerankerCandidates = candidates.length;
    q.diag.rerankerApplied = false;
    if (candidates.length === 0) {
      q.diag.rerankerReturned = 0;
      return [];
    }
    // Pass the public top-K separately from the expanded candidate pool. The
    // semantic worker uses it to resolve the hardware tier (20/40/64) and
    // returns exactly the calibrated final set. Candidates outside that set
    // receive a deterministic floor score below every reranked row, so raw
    // RRF and cross-encoder score scales are never mixed by final_top_k.
    let newScoreById = new Map<string, number>();
    let rerankedIds = new Set<string>();
    let floorScore: number | null = null;
    try {
      if (q.signal?.aborted) {
        throw q.signal.reason instanceof Error
          ? q.signal.reason
          : new Error('hybrid search request aborted before reranking');
      }
      // At most four async reads; one decode/split per file in this query.
      const sourceCache = new Map<string, string[]>();
      const budget = { bytes: 8 * 1024 * 1024 };
      if (this.db) {
        const paths = [...new Set(candidates.map(({ result }) => {
          const data = result.data as unknown as Record<string, unknown>;
          return String(result.type === 'file' ? data.path ?? '' : data.file_path ?? '');
        }))];
        await mapLimit(paths, 4, async (path) => {
          if (!q.signal?.aborted) sourceCache.set(path, await sourceText(this.db!, q.projectId, path, budget, q.signal));
        });
      }
      q.signal?.throwIfAborted();
      const rerankInput = candidates.map((candidate) => ({
        id: candidate.candidateId,
        text: rerankDocumentText(candidate.result, this.db, q.projectId, sourceCache),
        originalScore: candidate.score,
      }));
      const expected = Math.min(q.limit, candidates.length);
      const reranked = await this.reranker.rerank(q.query, rerankInput, expected, {
        supersessionKey: q.supersessionKey,
        signal: q.signal,
      });
      const allowed = new Set(rerankInput.map((candidate) => candidate.id));
      const ids = new Set<string>();
      if (reranked.length !== expected) {
        throw new Error(`${this.reranker.name} returned ${reranked.length}/${expected} results`);
      }
      for (const result of reranked) {
        if (!allowed.has(result.id) || ids.has(result.id) || !Number.isFinite(result.score)) {
          throw new Error(`${this.reranker.name} returned an invalid result set`);
        }
        ids.add(result.id);
      }
      newScoreById = new Map(reranked.map((result) => [result.id, result.score]));
      rerankedIds = ids;
      floorScore = Math.min(...reranked.map((result) => result.score)) - 1;
      q.diag.rerankerApplied = true;
      q.diag.rerankerReturned = reranked.length;
    } catch (error) {
      // RRF is a complete and deterministic ordering. A reranker outage must
      // never fail the query or erase candidates.
      console.warn(`[hybrid-search] ${this.reranker.name} unavailable; preserving RRF order: ${
        error instanceof Error ? error.message : String(error)
      }`);
      q.diag.rerankerError = error instanceof Error ? error.message : String(error);
      q.diag.rerankerReturned = 0;
    }
    return candidates.map((c, index) => {
      const newScore = newScoreById.get(c.candidateId)
        ?? (floorScore !== null && !rerankedIds.has(c.candidateId)
          ? floorScore - index * Number.EPSILON
          : c.score);
      return {
        ok: true as const,
        candidate: {
          ...c,
          score: newScore,
          result: { ...c.result, score: newScore },
        },
      };
    });
  }

  update(candidate: HybridSearchPipelineCandidate, hydrated: HybridSearchPipelineCandidate): void {
    candidate.score = hydrated.score;
    candidate.result = hydrated.result;
  }
}

// ─── SideEffect: cache write (when caller provides a sink) ───────────

export interface CacheWriteSinkArgs {
  setCache: (results: HybridSearchResult[]) => void;
}

export class CacheWriteSink
  implements SideEffect<HybridSearchPipelineQuery, HybridSearchPipelineCandidate>
{
  readonly name = 'cache_write';
  constructor(private args: CacheWriteSinkArgs) {}
  enable(): boolean {
    return true;
  }
  async sideEffect(input: {
    query: HybridSearchPipelineQuery;
    selectedCandidates: HybridSearchPipelineCandidate[];
  }): Promise<void> {
    const results = input.selectedCandidates.map((c) => c.result);
    this.args.setCache(results);
  }
}

// ─── Helpers (shared with legacy method for parity) ──────────────────

function buildTemplateVariants(query: string): string[] {
  const trimmed = query.trim();
  const variants = new Set<string>();
  variants.add(trimmed);
  const topic = trimmed
    .replace(
      /^(how\s+(?:does|do|is|are|can|to)|what\s+(?:is|does|are)|where\s+(?:is|does|are)|why\s+(?:is|does|are))\s+/i,
      '',
    )
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

// ─── Factory ──────────────────────────────────────────────────────────

export interface CreateHybridPipelineOptions {
  db: CodeIndexDB;
  vectorStore: VectorStore | null;
  embeddingService: EmbeddingService;
  hyde: HyDEService | null;
  reranker: RerankerService;
  recentFilesSource: RecentFilesSource | null;
  /** Sanitization helper from HybridSearch — keeps FTS parity (connector-aware). */
  ftsSanitize: (q: string, connector: 'AND' | 'OR') => string;
  /** Optional telemetry sink (e.g. SqliteTelemetrySink). */
  telemetry?: TelemetrySink;
  /** Optional cache writeback. */
  cacheWrite?: (results: HybridSearchResult[]) => void;
}

export function createHybridSearchPipeline(
  opts: CreateHybridPipelineOptions,
): CandidatePipeline<HybridSearchPipelineQuery, HybridSearchPipelineCandidate> {
  const rerankerEnabled = !(opts.reranker instanceof NullReranker);
  const rawInputs: RawSearchInputs = {
    db: opts.db,
    vectorStore: opts.vectorStore,
    embeddingService: opts.embeddingService,
    hyde: opts.hyde,
    recentFilesSource: opts.recentFilesSource,
    ftsSanitize: opts.ftsSanitize,
  };
  const sideEffects: SideEffect<HybridSearchPipelineQuery, HybridSearchPipelineCandidate>[] = [];
  if (opts.cacheWrite) {
    sideEffects.push(new CacheWriteSink({ setCache: opts.cacheWrite }));
  }
  return new CandidatePipeline<HybridSearchPipelineQuery, HybridSearchPipelineCandidate>(
    {
      name: 'indexer_search',
      telemetry: opts.telemetry,
      // The merge of multiple sources can produce many duplicates;
      // bump the safety cap above the framework default 10k so we
      // never trim before dedup runs.
      maxCandidates: 50_000,
    },
    {
      sources: [
        new FtsSource(rawInputs),
        new VectorSource(rawInputs),
        new RecentFilesSourceStage({ db: opts.db, recent: opts.recentFilesSource }),
        new ContentSource(rawInputs),
        new GraphSource(rawInputs),
      ],
      scorers: [new RrfFusionScorer()],
      postScoringFilters: [new DedupFilter()],
      selector: new TopKSelector<HybridSearchPipelineQuery, HybridSearchPipelineCandidate>({
        name: 'rerank_depth',
        // Bound cross-encoder cost without applying the public top-K before
        // reranking. With no reranker this is already the final result depth.
        k: (query) => rerankerEnabled ? rerankDepth(query, opts.reranker) : query.limit,
        scoreOf: (c) => c.score,
      }),
      postSelectionHydrators:
        rerankerEnabled ? [new RerankerHydrator(opts.reranker, opts.db)] : undefined,
      postSelectionSelector: new TopKSelector<
        HybridSearchPipelineQuery,
        HybridSearchPipelineCandidate
      >({
        name: 'final_top_k',
        k: (query) => query.limit,
        scoreOf: (c) => c.score,
      }),
      sideEffects: sideEffects.length > 0 ? sideEffects : undefined,
    },
  );
}

/**
 * Convenience: run the pipeline and unwrap the candidates back to
 * `HybridSearchResult[]`. The caller still owns the cache-key /
 * planner / mode-selection logic — this helper is purely
 * candidates-in → ranked-results-out.
 */
export async function runHybridSearchPipeline(
  pipeline: CandidatePipeline<HybridSearchPipelineQuery, HybridSearchPipelineCandidate>,
  query: HybridSearchPipelineQuery,
): Promise<HybridSearchResult[]> {
  const result = await pipeline.execute(query);
  // Factory pipelines already apply final_top_k after reranking. Keep the
  // slice as a defensive bound for callers supplying a custom pipeline.
  return result.selected
    .slice()
    .sort((a, b) => b.score - a.score)
    .slice(0, query.limit)
    .map((candidate) => ({ ...candidate.result, score: candidate.score }));
}

// Re-export the snapshot type so callers can use it without dragging
// `@mcp/shared/types` in.
export type { ContextSnapshot };
