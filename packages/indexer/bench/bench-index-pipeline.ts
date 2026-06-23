/**
 * Index pipeline benchmark — throughput + peak-RSS baseline and regression gate.
 *
 * Measures the four scan/index scenarios that matter for the perf overhaul:
 *   - cold          — first index of a fresh project (all files new)
 *   - warm_nochange — immediate re-index, nothing changed (scan cost only)
 *   - touch_all     — mtime bumped on every file, content identical
 *   - change_10pct  — 10% of files actually edited
 * …for each tree-sitter dispatch mode (workers off / on).
 *
 * Uses the real CodeIndexDB + sqlite-vec store on a temp dir with the fake
 * LLM provider + fake embedding service from the test harness, so numbers
 * isolate the pipeline itself (scan, hash, tree-sitter, persistence, embed
 * batching) from network/LLM noise.
 *
 * RSS note: scenarios run in one process, so absolute RSS accumulates
 * (sqlite page cache, wasm grammars). Compare `rss_delta_mb`/`rss_peak_mb`
 * per scenario across bench runs, not across scenarios within a run.
 *
 * Run:
 *   pnpm tsx packages/indexer/bench/bench-index-pipeline.ts \
 *     [--files=300] [--workers=both|on|off] [--no-embeddings] [--concurrency=5]
 */
import { performance } from 'node:perf_hooks';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodeIndexDB } from '@mcp/store/db.js';
import { SqliteVecVectorStore } from '@mcp/store/sqlite-vec-store.js';
import { CostTracker } from '@mcp/services/services/costs.js';
import type { IndexerConfig } from '@mcp/shared/utils/config.js';
import { IndexAgent } from '@mcp/indexer/indexer/indexer.js';
import { NullEmbeddingService } from '@mcp/indexer/search/embeddings.js';
import { closeIndexJobPool } from '@mcp/indexer/workers/indexJob/client.js';
import {
  FakeProvider, FakeEmbeddingService, bigFunctionFixture, smallFileFixture,
} from '@mcp/indexer/indexer/__tests__/index-agent-harness.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Args ───────────────────────────────────────────────────────────────
const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const FILE_COUNT = Number(arg('files') ?? 300);
const BIG_EVERY = 15;                       // every 15th file gets a multi-window body
const CONCURRENCY = Number(arg('concurrency') ?? 5);
const NO_EMBEDDINGS = process.argv.includes('--no-embeddings');
const WORKER_MODES: Array<'off' | 'on'> =
  arg('workers') === 'on' ? ['on'] : arg('workers') === 'off' ? ['off'] : ['off', 'on'];

interface ScenarioResult {
  scenario: string; workers: string; duration_ms: number; files_per_sec: number;
  indexed: number; skipped: number; errors: number;
  rss_start_mb: number; rss_peak_mb: number; rss_delta_mb: number;
  /** Indexer-side phase breakdown (scan/analyze/embed/sweep + its own peak). */
  phases?: import('@mcp/shared/types.js').RunPhaseTelemetry;
}

// ─── RSS sampler ────────────────────────────────────────────────────────
function startRssSampler(): { stop(): { startMb: number; peakMb: number } } {
  const mb = () => Math.round(process.memoryUsage().rss / 1e6);
  const startMb = mb();
  let peakMb = startMb;
  const timer = setInterval(() => { peakMb = Math.max(peakMb, mb()); }, 25);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      peakMb = Math.max(peakMb, mb());
      return { startMb, peakMb };
    },
  };
}

// ─── Fixture project ────────────────────────────────────────────────────
function writeFixture(root: string, count: number): string[] {
  const paths: string[] = [];
  for (let i = 0; i < count; i++) {
    const sub = join(root, `mod${i % 10}`);
    if (i % 10 === i) mkdirSync(sub, { recursive: true });
    const p = join(sub, `file${i}.ts`);
    const body = i % BIG_EVERY === 0
      ? bigFunctionFixture(`bigFn${i}`)
      : `${smallFileFixture(`fn${i}`)}\nexport const TAG_${i} = '${i}';\n`;
    writeFileSync(p, body, 'utf-8');
    paths.push(p);
  }
  return paths;
}

interface Bench {
  dir: string; root: string; agent: IndexAgent; db: CodeIndexDB; files: string[];
}

function setup(name: string): Bench {
  const dir = mkdtempSync(join(tmpdir(), `mcp-idx-bench-${name}-`));
  const root = join(dir, 'proj');
  mkdirSync(root);
  const files = writeFixture(root, FILE_COUNT);
  const db = new CodeIndexDB(join(dir, 'index.db'));
  db.createProject(`bench-${name}`, root);
  const vectorStore = new SqliteVecVectorStore({ path: join(dir, 'vec.db') });
  const embedding = NO_EMBEDDINGS ? new NullEmbeddingService() : new FakeEmbeddingService();
  const config = {
    dbPath: join(dir, 'index.db'), concurrency: CONCURRENCY, maxFileSize: 200,
    ignorePatterns: [], indexProfile: 'balanced',
  } as unknown as IndexerConfig;
  const agent = new IndexAgent(db, new FakeProvider(), embedding, vectorStore, new CostTracker(db), null, config);
  return { dir, root, agent, db, files };
}

function teardown(b: Bench): void {
  try { b.db.close(); } catch { /* */ }
  try { rmSync(b.dir, { recursive: true, force: true }); } catch { /* tmp leak ok */ }
}

// ─── Scenario runner (indexer logs silenced for a readable table) ───────
async function runScenario(name: string, workers: string, b: Bench): Promise<ScenarioResult> {
  const origError = console.error; const origWarn = console.warn;
  console.error = () => {}; console.warn = () => {};
  const sampler = startRssSampler();
  const t0 = performance.now();
  try {
    const res = await b.agent.indexProject(b.root);
    const durationMs = performance.now() - t0;
    const { startMb, peakMb } = sampler.stop();
    return {
      scenario: name, workers, duration_ms: Math.round(durationMs),
      files_per_sec: Math.round((res.totalFiles / Math.max(durationMs, 1)) * 1000),
      indexed: res.indexedFiles, skipped: res.skippedFiles, errors: res.errorCount,
      rss_start_mb: startMb, rss_peak_mb: peakMb, rss_delta_mb: peakMb - startMb,
      phases: res.phases,
    };
  } finally {
    console.error = origError; console.warn = origWarn;
  }
}

function touchAll(files: string[]): void {
  const now = new Date();
  for (const f of files) utimesSync(f, now, now);
}

function change10pct(files: string[]): void {
  for (let i = 0; i < files.length; i += 10) {
    writeFileSync(files[i], `${smallFileFixture(`changedFn${i}`)}\nexport const CHANGED_${i} = true;\n`, 'utf-8');
  }
}

// ─── Main ───────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  process.stderr.write(`Index pipeline bench — ${FILE_COUNT} files, concurrency ${CONCURRENCY}, embeddings=${!NO_EMBEDDINGS}, workers=${WORKER_MODES.join('+')}\n`);
  const results: ScenarioResult[] = [];

  for (const mode of WORKER_MODES) {
    // 'on' must be non-numeric: a numeric value would also override pool size.
    process.env.MCP_INDEX_WORKERS = mode === 'on' ? 'on' : '0';
    const b = setup(mode);
    try {
      results.push(await runScenario('cold', mode, b));
      results.push(await runScenario('warm_nochange', mode, b));
      touchAll(b.files);
      results.push(await runScenario('touch_all', mode, b));
      change10pct(b.files);
      results.push(await runScenario('change_10pct', mode, b));
    } finally {
      teardown(b);
    }
  }
  await closeIndexJobPool();

  const header = 'scenario'.padEnd(16) + 'workers'.padEnd(9) + 'ms'.padStart(8) + 'files/s'.padStart(9)
    + 'indexed'.padStart(9) + 'skipped'.padStart(9) + 'errors'.padStart(8)
    + 'rss_start'.padStart(11) + 'rss_peak'.padStart(10) + 'rss_delta'.padStart(11);
  process.stderr.write(`\n${header}\n${'─'.repeat(header.length)}\n`);
  for (const r of results) {
    process.stderr.write(
      r.scenario.padEnd(16) + r.workers.padEnd(9) + String(r.duration_ms).padStart(8)
      + String(r.files_per_sec).padStart(9) + String(r.indexed).padStart(9)
      + String(r.skipped).padStart(9) + String(r.errors).padStart(8)
      + `${r.rss_start_mb}MB`.padStart(11) + `${r.rss_peak_mb}MB`.padStart(10)
      + `${r.rss_delta_mb}MB`.padStart(11) + '\n',
    );
  }

  const resultsDir = join(__dirname, 'results');
  if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const file = join(resultsDir, `index-pipeline-${stamp}.json`);
  writeFileSync(file, JSON.stringify({
    generated_at: new Date().toISOString(),
    node: process.version,
    file_count: FILE_COUNT, concurrency: CONCURRENCY, embeddings: !NO_EMBEDDINGS,
    results,
  }, null, 2) + '\n', 'utf8');
  process.stderr.write(`\nResults written to ${file}\n`);
}

main().catch((err) => { console.error(err); process.exit(1); });
