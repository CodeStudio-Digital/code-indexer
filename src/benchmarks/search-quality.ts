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
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '@mcp/shared/utils/config.js';
import { CodeIndexDB } from '@mcp/store/db.js';
import { ProviderStore } from '@mcp/store/provider-store.js';
import { createEmbeddingService } from '@mcp/indexer/search/embeddings.js';
import { createVectorStore, NullVectorStore } from '@mcp/store/vectors.js';
import { HybridSearch } from '@mcp/indexer/search/hybrid.js';
import { HyDEService } from '@mcp/indexer/search/hyde.js';
import { createReranker, NullReranker } from '@mcp/indexer/search/reranker.js';
import { runBenchmark, type CellResult, type EmbeddingEntry } from '@mcp/indexer/benchmarks/engine.js';
import { buildReranker, buildEmbedding } from '@mcp/indexer/benchmarks/specs.js';
import { buildScratchVectorStore } from '@mcp/indexer/benchmarks/scratch-index.js';
import { generateQueriesFromIndex } from '@mcp/indexer/benchmarks/query-gen.js';
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

function printMatrix(rows: CellResult[]): void {
  // Winner = highest nDCG@10 (tie-break MRR), flagged with ★.
  let best = -1;
  for (let i = 0; i < rows.length; i++) {
    if (
      best === -1 ||
      rows[i].ndcg_at_10 > rows[best].ndcg_at_10 ||
      (rows[i].ndcg_at_10 === rows[best].ndcg_at_10 && rows[i].mrr > rows[best].mrr)
    ) {
      best = i;
    }
  }
  const header = ['', 'embedding', 'reranker', 'R@5', 'R@10', 'MRR', 'nDCG@10', 'p50', 'p95', 'N'];
  const widths = header.map((h) => h.length);
  const cells: string[][] = rows.map((r, i) => [
    i === best ? '*' : '',
    r.embedding,
    r.reranker,
    r.recall_at_5.toFixed(3),
    r.recall_at_10.toFixed(3),
    r.mrr.toFixed(3),
    r.ndcg_at_10.toFixed(3),
    String(r.p50_ms),
    String(r.p95_ms),
    String(r.queries),
  ]);
  for (const row of cells) {
    for (let i = 0; i < row.length; i++) widths[i] = Math.max(widths[i], row[i].length);
  }
  const pad = (s: string, w: number) => s.padEnd(w, ' ');
  console.log(header.map((h, i) => pad(h, widths[i])).join('  '));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of cells) console.log(row.map((c, i) => pad(c, widths[i])).join('  '));
  if (best !== -1) {
    console.log(
      `\n* best: ${rows[best].embedding} × ${rows[best].reranker} (nDCG@10 ${rows[best].ndcg_at_10.toFixed(3)}, MRR ${rows[best].mrr.toFixed(3)})`,
    );
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      project: { type: 'string' },
      file: { type: 'string' },
      modes: { type: 'string' },
      'no-hyde': { type: 'boolean' },
      // Force the passthrough reranker (RRF order) — for A/B against the
      // production default resolved from the provider store.
      'no-rerank': { type: 'boolean' },
      'min-recall': { type: 'string' },
      // Which mode the --min-recall gate applies to. Default: best across
      // the run modes (legacy behavior, lets fts mask a hybrid regression).
      'gate-mode': { type: 'string' },
      // Optional: write results JSON to disk for diffing against future runs.
      // Used by the baseline workflow. Default: do not write a file (legacy behavior).
      output: { type: 'string' },
      'save-baseline': { type: 'boolean' },
      // Matrix mode: comma-separated reranker/embedding specs to compare side
      // by side (see benchmarks/specs.ts). When either is set, the script runs
      // the (embedding × reranker) matrix under a single --mode instead of the
      // legacy per-mode loop.
      rerankers: { type: 'string' },
      embeddings: { type: 'string' },
      mode: { type: 'string' },
      // Auto-generate the query set from the local symbol index (zero manual
      // labeling). Replaces --file/builtin when set.
      generate: { type: 'boolean' },
      'max-queries': { type: 'string' },
      // Cap on files re-embedded per non-live embedding (ground-truth targets
      // always included). Controls cost/time of the embedding-comparison flow.
      sample: { type: 'string' },
    },
  });

  if (!values.project) {
    console.error(
      'Usage: tsx src/benchmarks/search-quality.ts --project <name> [--file queries.jsonl] [--modes fts,vector,hybrid,expanded] [--no-hyde] [--no-rerank] [--min-recall 0.7] [--gate-mode hybrid]'
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
  // Match production wiring (deps.ts, mcp-server): resolve the admin-managed
  // default from the provider store — after `seedFromEnvIfEmpty()` that is
  // LocalReranker, NOT NullReranker. Passing no store here would silently
  // benchmark a reranker-less stack production never runs.
  const reranker = values['no-rerank'] ? new NullReranker() : createReranker(providerStore);
  const search = new HybridSearch(db, searchable, embeddingService, hyde, reranker);

  const maxQueries = values['max-queries'] ? parseInt(values['max-queries'], 10) : undefined;
  let { queries, source } = loadQueries(values.file);
  if (values.generate) {
    const gen = generateQueriesFromIndex(db, project.id, { maxQueries });
    if (gen.length === 0) {
      console.error(`[bench] --generate produced 0 queries (no commented symbols?); keeping ${source}`);
    } else {
      queries = gen;
      source = `generated(${gen.length})`;
      const genPath = `evals/${project.name.replace(/[^a-z0-9._-]+/gi, '_')}.generated.jsonl`;
      try {
        writeFileSync(genPath, gen.map((q) => JSON.stringify(q)).join('\n') + '\n');
        console.log(`[bench] generated query set written to ${genPath}`);
      } catch {
        /* best-effort dump; the in-memory set is what's benchmarked */
      }
    }
  }

  // ── Matrix mode: compare reranker/embedding configs side by side ──────────
  // Triggered by --rerankers/--embeddings. Runs the (embedding × reranker)
  // matrix under one --mode instead of the legacy per-mode loop.
  if (values.rerankers || values.embeddings) {
    const rerankerSpecs = (values.rerankers ?? 'default').split(',').map((s) => s.trim()).filter(Boolean);
    const embSpecs = (values.embeddings ?? 'live').split(',').map((s) => s.trim()).filter(Boolean);
    const rerankers = rerankerSpecs.map((s) => buildReranker(s, providerStore));

    // Non-live embeddings need their vectors re-embedded into a throwaway store
    // (different vector space). Targets from the query set are always embedded
    // so recall stays measurable under --sample.
    const sample = values.sample ? parseInt(values.sample, 10) : undefined;
    const targetFiles = new Set<string>();
    for (const q of queries) for (const f of q.relevant_files ?? []) targetFiles.add(f);

    const embeddings: EmbeddingEntry[] = [];
    for (const s of embSpecs) {
      const e = buildEmbedding(s, providerStore);
      if (!e.needsScratch) {
        embeddings.push({ label: e.label, service: e.service, vectorStore: searchable });
        continue;
      }
      const safe = `${project.name}.${s}`.replace(/[^a-z0-9._-]+/gi, '_');
      const scratchPath = join('bench', 'scratch', `${safe}.db`);
      mkdirSync(dirname(scratchPath), { recursive: true });
      if (existsSync(scratchPath)) rmSync(scratchPath); // clean rebuild — dim may differ from a prior model
      if (s.startsWith('provider')) {
        console.warn(
          `[bench] '${s}' is a remote/paid embedding — re-embedding the corpus costs API calls${sample ? ` (sampled to ${sample} files)` : ' (FULL corpus; consider --sample N)'}`,
        );
      }
      console.log(`[bench] reindexing corpus for '${s}' -> ${scratchPath}`);
      const { store, embedded, tokens, files } = await buildScratchVectorStore(db, project, e.service, {
        scratchPath,
        sample,
        targetFiles,
        onProgress: (p) => process.stdout.write(`\r  embed ${s}: ${p.current}/${p.total} files   `),
      });
      process.stdout.write('\n');
      console.log(`[bench] '${s}': ${embedded} vectors from ${files} files, ~${tokens} tokens`);
      embeddings.push({ label: e.label, service: e.service, vectorStore: store });
    }
    const matrixMode = (values.mode as SearchMode | 'expanded') ?? 'hybrid';
    console.log(`\n[bench] matrix project=${project.name} queries=${queries.length} source=${source} hyde=${hyde ? 'real' : 'off'} mode=${matrixMode}`);
    console.log(`[bench] embeddings: ${embeddings.map((e) => e.label).join(', ')}`);
    console.log(`[bench] rerankers:  ${rerankers.map((r) => r.label).join(', ')}\n`);
    const cells = await runBenchmark(
      {
        db,
        projectId: project.id,
        projectName: project.name,
        querySet: queries,
        embeddings,
        rerankers,
        hyde,
        mode: matrixMode,
        limit: 20,
      },
      (p) => process.stdout.write(`\r  ${p.cell}: ${p.current}/${p.total}      `),
    );
    process.stdout.write('\n\n');
    printMatrix(cells);
    db.close();
    return;
  }

  console.log(`\n[bench] project=${project.name} queries=${queries.length} source=${source} hyde=${hyde ? 'real' : 'off'} reranker=${reranker.name}`);
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

  // Optional persistence — only when --output or --save-baseline is set.
  // Legacy invocations (CI gate without --save-baseline) keep writing nothing.
  if (values.output || values['save-baseline']) {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const repoRoot = resolve(__dirname, '..', '..');
    const outDir = join(repoRoot, 'bench', 'results');
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const outPath = values.output ?? join(outDir, `search-baseline-${day}.json`);
    const payload = {
      generatedAt: new Date().toISOString(),
      project: project.name,
      projectId: project.id,
      querySource: source,
      queryCount: queries.length,
      hyde: hyde ? 'real' : 'off',
      modes,
      results,
    };
    writeFileSync(outPath, JSON.stringify(payload, null, 2));
    console.log(`[bench] results written to ${outPath}`);
  }

  db.close();

  // CI gate: if --min-recall set, fail when recall@10 is under the threshold.
  // By default "best across run modes" (legacy — at least one mode hits the
  // bar). With --gate-mode the gate pins a single mode, so e.g. fts can no
  // longer mask a hybrid regression.
  if (Number.isFinite(minRecall)) {
    const gateMode = values['gate-mode'];
    const gated = gateMode ? results.filter((r) => r.mode === gateMode) : results;
    if (gated.length === 0) {
      console.error(
        gateMode
          ? `\n[bench] FAIL: --gate-mode ${gateMode} did not run (modes: ${results.map((r) => r.mode).join(', ') || 'none'})`
          : '\n[bench] FAIL: no mode produced results'
      );
      process.exit(1);
    }
    const label = gateMode ? `${gateMode} recall@10` : 'best recall@10';
    const bestRecall = Math.max(...gated.map((r) => r.recall_at_10));
    if (bestRecall < minRecall) {
      console.error(
        `\n[bench] FAIL: ${label} ${bestRecall.toFixed(3)} < threshold ${minRecall.toFixed(3)}`
      );
      process.exit(1);
    }
    console.log(`\n[bench] PASS: ${label} ${bestRecall.toFixed(3)} >= threshold ${minRecall.toFixed(3)}`);
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
