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
import { HybridSearch } from '@mcp/indexer/search/hybrid.js';
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
}

export interface BenchmarkProgress {
  current: number;
  total: number;
  cell: string;
  message?: string;
}

/** Did the result hit any declared relevant target? (binary relevance) */
export function isRelevant(result: HybridSearchResult, q: EvalQuery): boolean {
  const data = result.data as unknown as Record<string, unknown>;
  if (result.type === 'file') {
    const path = (data.path as string) ?? '';
    return (q.relevant_files ?? []).some((rf) => path === rf || path.endsWith(rf));
  }
  const name = (data.name as string) ?? '';
  const filePath = (data.file_path as string) ?? '';
  const symOk = (q.relevant_symbols ?? []).some((rs) => name === rs);
  const fileOk = (q.relevant_files ?? []).some((rf) => filePath === rf || filePath.endsWith(rf));
  return symOk || fileOk;
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
  const R = Math.min(k, (q.relevant_files?.length ?? 0) + (q.relevant_symbols?.length ?? 0));
  if (R === 0) return 0;
  let dcg = 0;
  let credited = 0;
  for (let i = 0; i < Math.min(results.length, k) && credited < R; i++) {
    if (isRelevant(results[i], q)) {
      dcg += 1 / Math.log2(i + 2);
      credited++;
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

      for (const q of cfg.querySet) {
        const start = Date.now();
        let results: HybridSearchResult[];
        if (mode === 'expanded') {
          results = await search.searchExpanded(cfg.projectId, cfg.projectName, q.query, {
            type: 'all',
            limit,
          });
        } else {
          results = await search.search(cfg.projectId, cfg.projectName, q.query, {
            mode: mode as SearchMode,
            type: 'all',
            limit,
          });
        }
        latencies.push(Date.now() - start);

        let firstHit = -1;
        for (let i = 0; i < results.length; i++) {
          if (isRelevant(results[i], q)) {
            firstHit = i;
            break;
          }
        }
        if (firstHit !== -1 && firstHit < 5) r5++;
        if (firstHit !== -1 && firstHit < 10) r10++;
        rr += firstHit === -1 ? 0 : 1 / (firstHit + 1);
        ndcg += ndcgAt(results, q, 10);

        current++;
        onProgress?.({ current, total, cell });
      }

      out.push({
        embedding: emb.label,
        reranker: rer.label,
        recall_at_5: n ? r5 / n : 0,
        recall_at_10: n ? r10 / n : 0,
        mrr: n ? rr / n : 0,
        ndcg_at_10: n ? ndcg / n : 0,
        p50_ms: percentile(latencies, 50),
        p95_ms: percentile(latencies, 95),
        queries: n,
      });
    }
  }

  return out;
}
