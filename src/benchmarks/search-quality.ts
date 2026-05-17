/**
 * Search quality benchmark.
 *
 * Runs a set of labeled queries against an indexed project and reports
 * recall@k, MRR, and median latency per search mode. Lets you measure the
 * impact of the v3.12 embedding upgrades (sb_ symbol bodies, server-side
 * filtering, real HyDE) vs a baseline.
 *
 * Usage:
 *   tsx src/benchmarks/search-quality.ts --project <name> [--file queries.jsonl]
 *   tsx src/benchmarks/search-quality.ts --project CodeStudio/MCP-CodeBase --modes fts,hybrid,expanded
 *   tsx src/benchmarks/search-quality.ts --project foo --min-recall 0.7   # CI gate
 *
 * Input format (JSONL, one query per line):
 *   {"query": "how does the indexer handle incremental reindex",
 *    "relevant_files": ["src/core/indexer/indexer.ts"],
 *    "relevant_symbols": ["processEmbeddings"]}
 *
 * If --file is omitted, the script auto-loads `evals/queries.jsonl` from the
 * current working directory when it exists. Otherwise a minimal synthetic
 * set is used so the script is runnable out of the box on any project — the
 * numbers won't be scientific but they are reproducible and let you spot
 * regressions.
 *
 * When --min-recall is set, the process exits with code 1 if the best
 * recall@10 across the selected modes drops below the threshold. Use this
 * in CI to gate retrieval regressions.
 */
import { parseArgs } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import { loadConfig } from '@mcp/shared/utils/config.js';
import { CodeIndexDB } from '@mcp/store/db.js';
import { ProviderStore } from '@mcp/store/provider-store.js';
import { createEmbeddingService } from '@mcp/indexer/search/embeddings.js';
import { createVectorStore, NullVectorStore } from '@mcp/store/vectors.js';
import { HybridSearch } from '@mcp/indexer/search/hybrid.js';
import { HyDEService } from '@mcp/indexer/search/hyde.js';
import type { HybridSearchResult, SearchMode } from '@mcp/shared/types.js';

interface EvalQuery {
  query: string;
  relevant_files?: string[];
  relevant_symbols?: string[];
}

interface ModeResult {
  mode: string;
  recall_at_5: number;
  recall_at_10: number;
  mrr: number;
  median_ms: number;
  p95_ms: number;
  queries: number;
}

const BUILTIN_QUERIES: EvalQuery[] = [
  {
    query: 'how does the indexer handle incremental reindex',
    relevant_files: ['src/core/indexer/indexer.ts'],
  },
  {
    query: 'vector store abstraction and factory',
    relevant_files: ['src/store/vectors.ts'],
  },
  {
    query: 'hybrid search with RRF merge',
    relevant_files: ['src/core/search/hybrid.ts'],
  },
  {
    query: 'snapshot embedding and upsert into vector store',
    relevant_files: ['src/core/services/snapshots.ts'],
  },
  {
    query: 'HyDE query expansion with LLM',
    relevant_files: ['src/core/search/hyde.ts', 'src/core/search/hybrid.ts'],
  },
];

/**
 * Default JSONL gold set checked into the repo. Picked up when --file is
 * omitted and the file exists at CWD — keeps `npm run eval` zero-config.
 */
const DEFAULT_QUERIES_PATH = 'evals/queries.jsonl';

function loadQueries(path?: string): { queries: EvalQuery[]; source: string } {
  // Explicit path always wins.
  if (path) {
    if (!existsSync(path)) {
      console.error(`[bench] query file not found: ${path}, falling back to builtin set`);
      return { queries: BUILTIN_QUERIES, source: 'builtin (file not found)' };
    }
    return { queries: parseJsonl(path), source: path };
  }
  // No --file: try the checked-in default at CWD.
  if (existsSync(DEFAULT_QUERIES_PATH)) {
    return { queries: parseJsonl(DEFAULT_QUERIES_PATH), source: DEFAULT_QUERIES_PATH };
  }
  return { queries: BUILTIN_QUERIES, source: 'builtin' };
}

function parseJsonl(path: string): EvalQuery[] {
  const text = readFileSync(path, 'utf-8');
  const out: EvalQuery[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    try {
      out.push(JSON.parse(trimmed) as EvalQuery);
    } catch (e) {
      console.error(`[bench] skipping malformed line: ${(e as Error).message}`);
    }
  }
  return out;
}

function isRelevant(result: HybridSearchResult, q: EvalQuery): boolean {
  const data = result.data as unknown as Record<string, unknown>;
  if (result.type === 'file') {
    const path = (data.path as string) ?? '';
    return (q.relevant_files ?? []).some((rf) => path === rf || path.endsWith(rf));
  }
  // symbol
  const name = (data.name as string) ?? '';
  const filePath = (data.file_path as string) ?? '';
  const symOk = (q.relevant_symbols ?? []).some((rs) => name === rs);
  const fileOk = (q.relevant_files ?? []).some((rf) => filePath === rf || filePath.endsWith(rf));
  return symOk || fileOk;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[idx];
}

async function evalMode(
  mode: 'fts' | 'vector' | 'hybrid' | 'expanded',
  search: HybridSearch,
  projectId: number,
  projectName: string,
  queries: EvalQuery[]
): Promise<ModeResult> {
  const latencies: number[] = [];
  let totalRecall5 = 0;
  let totalRecall10 = 0;
  let totalRR = 0; // reciprocal rank

  for (const q of queries) {
    const start = Date.now();
    let results: HybridSearchResult[];
    if (mode === 'expanded') {
      results = await search.searchExpanded(projectId, projectName, q.query, {
        type: 'all',
        limit: 20,
      });
    } else {
      results = await search.search(projectId, projectName, q.query, {
        mode: mode as SearchMode,
        type: 'all',
        limit: 20,
      });
    }
    latencies.push(Date.now() - start);

    // Recall@k — did we hit ANY relevant result in the top K?
    let firstHitRank = -1;
    for (let i = 0; i < results.length; i++) {
      if (isRelevant(results[i], q)) {
        if (firstHitRank === -1) firstHitRank = i;
      }
    }
    if (firstHitRank !== -1 && firstHitRank < 5) totalRecall5++;
    if (firstHitRank !== -1 && firstHitRank < 10) totalRecall10++;
    totalRR += firstHitRank === -1 ? 0 : 1 / (firstHitRank + 1);
  }

  return {
    mode,
    recall_at_5: totalRecall5 / queries.length,
    recall_at_10: totalRecall10 / queries.length,
    mrr: totalRR / queries.length,
    median_ms: percentile(latencies, 50),
    p95_ms: percentile(latencies, 95),
    queries: queries.length,
  };
}

function printTable(rows: ModeResult[]): void {
  const header = ['mode', 'R@5', 'R@10', 'MRR', 'p50(ms)', 'p95(ms)', 'N'];
  const widths = header.map((h) => h.length);
  const cells: string[][] = rows.map((r) => [
    r.mode,
    r.recall_at_5.toFixed(3),
    r.recall_at_10.toFixed(3),
    r.mrr.toFixed(3),
    String(r.median_ms),
    String(r.p95_ms),
    String(r.queries),
  ]);
  for (const row of cells) {
    for (let i = 0; i < row.length; i++) {
      widths[i] = Math.max(widths[i], row[i].length);
    }
  }
  const pad = (s: string, w: number) => s.padEnd(w, ' ');
  console.log(header.map((h, i) => pad(h, widths[i])).join('  '));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of cells) {
    console.log(row.map((c, i) => pad(c, widths[i])).join('  '));
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      project: { type: 'string' },
      file: { type: 'string' },
      modes: { type: 'string' },
      'no-hyde': { type: 'boolean' },
      'min-recall': { type: 'string' },
    },
  });

  if (!values.project) {
    console.error(
      'Usage: tsx src/benchmarks/search-quality.ts --project <name> [--file queries.jsonl] [--modes fts,vector,hybrid,expanded] [--no-hyde] [--min-recall 0.7]'
    );
    process.exit(1);
  }

  const modes = (values.modes?.split(',') as Array<'fts' | 'vector' | 'hybrid' | 'expanded'>) ?? [
    'fts',
    'hybrid',
    'expanded',
  ];

  const minRecallRaw = values['min-recall'];
  const minRecall = minRecallRaw !== undefined ? Number(minRecallRaw) : NaN;
  if (minRecallRaw !== undefined && (!Number.isFinite(minRecall) || minRecall < 0 || minRecall > 1)) {
    console.error(`[bench] --min-recall must be a number in [0, 1], got: ${minRecallRaw}`);
    process.exit(1);
  }

  const config = loadConfig();
  const db = new CodeIndexDB(config.dbPath);
  const project = db.resolveProject(values.project);

  const providerStore = new ProviderStore(config.dbPath);
  providerStore.seedFromEnvIfEmpty();
  const embeddingService = createEmbeddingService(providerStore);
  const vectorStore = createVectorStore(providerStore);
  const searchable = vectorStore instanceof NullVectorStore ? null : vectorStore;
  const hyde = values['no-hyde'] ? null : new HyDEService(providerStore);
  const search = new HybridSearch(db, searchable, embeddingService, hyde);

  const { queries, source } = loadQueries(values.file);
  console.log(`\n[bench] project=${project.name} queries=${queries.length} source=${source} hyde=${hyde ? 'real' : 'off'}`);
  console.log(`[bench] modes: ${modes.join(', ')}\n`);

  const results: ModeResult[] = [];
  for (const mode of modes) {
    process.stdout.write(`  running ${mode}… `);
    const t0 = Date.now();
    try {
      const r = await evalMode(mode, search, project.id, project.name, queries);
      results.push(r);
      console.log(`done (${Date.now() - t0}ms)`);
    } catch (e) {
      console.log(`FAILED: ${(e as Error).message}`);
    }
  }

  console.log('');
  printTable(results);
  console.log('');

  // Highlight lift from fts → expanded if both were run.
  const fts = results.find((r) => r.mode === 'fts');
  const exp = results.find((r) => r.mode === 'expanded');
  if (fts && exp && fts.recall_at_10 > 0) {
    const lift = ((exp.recall_at_10 - fts.recall_at_10) / fts.recall_at_10) * 100;
    console.log(
      `lift expanded vs fts: R@10 ${lift >= 0 ? '+' : ''}${lift.toFixed(1)}%  MRR ${
        exp.mrr - fts.mrr >= 0 ? '+' : ''
      }${(exp.mrr - fts.mrr).toFixed(3)}`
    );
  }

  db.close();

  // CI gate: if --min-recall set, fail when the BEST recall@10 across the
  // run modes is under the threshold. "Best" because users typically only
  // care that at least one configured mode hits the bar — not that every
  // mode does (e.g. fts alone is expected to lose to hybrid).
  if (Number.isFinite(minRecall)) {
    const bestRecall = results.length > 0
      ? Math.max(...results.map((r) => r.recall_at_10))
      : 0;
    if (bestRecall < minRecall) {
      console.error(
        `\n[bench] FAIL: best recall@10 ${bestRecall.toFixed(3)} < threshold ${minRecall.toFixed(3)}`
      );
      process.exit(1);
    }
    console.log(`\n[bench] PASS: best recall@10 ${bestRecall.toFixed(3)} >= threshold ${minRecall.toFixed(3)}`);
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
