/**
 * Search-quality benchmark engine.
 *
 * Runs a labeled query set through a MATRIX of (embedding × reranker) configs
 * against an indexed project and reports Recall@5/10, MRR, nDCG@10 and latency
 * per cell. The same engine backs the CLI (`src/benchmarks/search-quality.ts`)
 * and the dashboard benchmark panel (api-bus `benchmarkStream`), so quality
 * numbers are computed identically wherever they're shown.
 *
 * The engine is pure orchestration: callers build the embedding/reranker
 * instances (see `./specs.ts`) and pass them in. `HybridSearch` takes the
 * reranker and embedding service via its constructor, so a cell is just a
 * fresh `HybridSearch` over the same DB with a different (vectorStore, embed,
 * rerank) triple.
 */
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { VectorStore } from '@mcp/store/vectors.js';
import { HybridSearch, verifySemanticRetrieval } from '@mcp/indexer/search/hybrid.js';
import type { HyDEService } from '@mcp/indexer/search/hyde.js';
import type { EmbeddingService } from '@mcp/indexer/search/embeddings.js';
import type { RerankerService } from '@mcp/indexer/search/reranker.js';
import type { HybridSearchResult, SearchMode } from '@mcp/shared/types.js';

export interface EvalQuery {
  query: string;
  relevant_files?: string[];
  relevant_symbols?: string[];
}

/** One embedding model paired with the vector store that holds its vectors. */
export interface EmbeddingEntry {
  label: string;
  service: EmbeddingService;
  vectorStore: VectorStore | null;
}

export interface RerankerEntry {
  label: string;
  reranker: RerankerService;
}

export interface BenchmarkConfig {
  db: CodeIndexDB;
  projectId: number;
  projectName: string;
  querySet: EvalQuery[];
  embeddings: EmbeddingEntry[];
  rerankers: RerankerEntry[];
  hyde?: HyDEService | null;
  /** Single search mode the matrix runs under. 'expanded' uses searchExpanded. */
  mode?: SearchMode | 'expanded';
  limit?: number;
}

export interface CellResult {
  embedding: string;
  reranker: string;
  recall_at_5: number;
  recall_at_10: number;
  mrr: number;
  ndcg_at_10: number;
  p50_ms: number;
  p95_ms: number;
  queries: number;
  negative_queries: number;
  negative_accuracy: number | null;
}

export interface BenchmarkProgress {
  current: number;
  total: number;
  cell: string;
  message?: string;
}

/** Did the result hit any declared relevant target? (binary relevance) */
export function isRelevant(result: HybridSearchResult, q: EvalQuery): boolean {
  return matchedTargets(result, q).length > 0;
}

function targets(q: EvalQuery): string[] {
  return [...new Set([...(q.relevant_files ?? []).map(path => `file:${path.replaceAll('\\', '/')}`),
    ...(q.relevant_symbols ?? []).map(name => `symbol:${name}`)])];
}

function matchedTargets(result: HybridSearchResult, q: EvalQuery): string[] {
  const data = result.data as unknown as Record<string, unknown>;
  const path = String(result.type === 'file' ? data.path ?? '' : data.file_path ?? '').replaceAll('\\', '/');
  return targets(q).filter(target => target.startsWith('file:')
    ? path === target.slice(5) || path.endsWith('/' + target.slice(5))
    : result.type === 'symbol' && data.name === target.slice(7));
}

/** Recall credits distinct declared targets, not just the first relevant row. */
export function recallAt(results: HybridSearchResult[], q: EvalQuery, k = 10): number {
  const expected = targets(q);
  if (!expected.length) return 0;
  const found = new Set(results.slice(0, k).flatMap(result => matchedTargets(result, q)));
  return found.size / expected.length;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[idx];
}

/**
 * nDCG@k with binary relevance. The ideal ranking puts all R declared targets
 * at the top, so IDCG sums the first R discount terms; DCG credits at most R
 * relevant hits (a single target matched by several rows can't push nDCG > 1).
 */
export function ndcgAt(results: HybridSearchResult[], q: EvalQuery, k = 10): number {
  const R = Math.min(k, targets(q).length);
  if (R === 0) return 0;
  let dcg = 0;
  const credited = new Set<string>();
  for (let i = 0; i < Math.min(results.length, k) && credited.size < R; i++) {
    const target = matchedTargets(results[i], q).find(value => !credited.has(value));
    if (target) {
      dcg += 1 / Math.log2(i + 2);
      credited.add(target);
    }
  }
  let idcg = 0;
  for (let i = 0; i < R; i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

/**
 * Run the (embedding × reranker) matrix. Each cell re-runs the full query set
 * through a fresh HybridSearch so retrieval is identical and only the swapped
 * component varies — the difference in metrics is the component's effect.
 */
export async function runBenchmark(
  cfg: BenchmarkConfig,
  onProgress?: (p: BenchmarkProgress) => void,
): Promise<CellResult[]> {
  if (cfg.querySet.length === 0) throw new Error('benchmark requires at least one gold-set query');
  if (cfg.embeddings.length === 0 || cfg.rerankers.length === 0) {
    throw new Error('benchmark requires at least one embedding and reranker configuration');
  }
  const mode = cfg.mode ?? 'hybrid';
  const limit = cfg.limit ?? 20;
  const hyde = cfg.hyde ?? null;
  if (mode !== 'fts') {
    const missingVectors = cfg.embeddings
      .filter((embedding) => embedding.vectorStore === null)
      .map((embedding) => embedding.label);
    if (missingVectors.length > 0) {
      throw new Error(
        `semantic benchmark requires indexed vectors; unavailable for: ${missingVectors.join(', ')}`,
      );
    }
  }
  const n = cfg.querySet.length;
  const total = cfg.embeddings.length * cfg.rerankers.length * Math.max(n, 1);
  const out: CellResult[] = [];
  let current = 0;

  for (const emb of cfg.embeddings) {
    for (const rer of cfg.rerankers) {
      const cell = `${emb.label} × ${rer.label}`;
      const search = new HybridSearch(cfg.db, emb.vectorStore, emb.service, hyde, rer.reranker);
      const latencies: number[] = [];
      let r5 = 0;
      let r10 = 0;
      let rr = 0;
      let ndcg = 0;
      let negatives = 0, correctNegatives = 0;

      for (const q of cfg.querySet) {
        const hasTargets = targets(q).length > 0;
        const start = Date.now();
        let results: HybridSearchResult[];
        if (mode === 'expanded') {
          results = await search.searchExpanded(cfg.projectId, cfg.projectName, q.query, {
            type: 'all',
            limit,
            requireSemantic: hasTargets ? 'candidates' : true,
          });
        } else {
          const response = await search.searchWithDiag(cfg.projectId, cfg.projectName, q.query, {
            mode: mode as SearchMode,
            type: 'all',
            limit,
            bypassCache: true,
          });
          if (mode !== 'fts' && !(mode === 'auto' && response.diagnostics.plannedMode === 'fts')) {
            verifySemanticRetrieval(response.diagnostics, hasTargets);
          }
          results = response.results;
        }
        latencies.push(Date.now() - start);

        let firstHit = -1;
        for (let i = 0; i < results.length; i++) {
          if (isRelevant(results[i], q)) {
            firstHit = i;
            break;
          }
        }
        r5 += recallAt(results, q, 5);
        r10 += recallAt(results, q, 10);
        if (!hasTargets) { negatives++; if (!results.length) correctNegatives++; }
        rr += firstHit === -1 ? 0 : 1 / (firstHit + 1);
        ndcg += ndcgAt(results, q, 10);

        current++;
        onProgress?.({ current, total, cell });
      }

      out.push({
        embedding: emb.label,
        reranker: rer.label,
        recall_at_5: n > negatives ? r5 / (n - negatives) : 0,
        recall_at_10: n > negatives ? r10 / (n - negatives) : 0,
        mrr: n > negatives ? rr / (n - negatives) : 0,
        ndcg_at_10: n > negatives ? ndcg / (n - negatives) : 0,
        p50_ms: percentile(latencies, 50),
        p95_ms: percentile(latencies, 95),
        queries: n,
        negative_queries: negatives,
        negative_accuracy: negatives ? correctNegatives / negatives : null,
      });
    }
  }

  return out;
}
