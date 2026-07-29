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
 * Uses the real CodeIndexDB and structural scanner/tree-sitter pipeline.
 * Semantic backfill is benchmarked separately because it is scheduled and
 * owned by the semantic worker rather than the project-open critical path.
 *
 * RSS note: scenarios run in one process, so absolute RSS accumulates
 * (sqlite page cache, wasm grammars). Compare `rss_delta_mb`/`rss_peak_mb`
 * per scenario across bench runs, not across scenarios within a run.
 *
 * Run:
 *   pnpm tsx packages/indexer/bench/bench-index-pipeline.ts \
 *     [--files=300] [--workers=both|on|off] [--concurrency=5] [--pool-size=4]
 *     [--big-every=15] [--big-lines=90]
 */
import { performance } from 'node:perf_hooks';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodeIndexDB } from '@mcp/store/db.js';
import { runStructuralIndex } from '@mcp/indexer/indexer/structural.js';
import { closeIndexJobPool } from '@mcp/indexer/workers/indexJob/client.js';

function smallFileFixture(fnName: string): string {
  return `export function ${fnName}(value: number): number {\n  return value * 2;\n}\n`;
}

function bigFunctionFixture(name: string, lines: number): string {
  return `export function ${name}(value: number): number {\n${Array.from(
    { length: lines },
    (_, index) => `  value += ${index};`,
  ).join('\n')}\n  return value;\n}\n`;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Args ───────────────────────────────────────────────────────────────
const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const FILE_COUNT = Number(arg('files') ?? 300);
const BIG_EVERY = Number(arg('big-every') ?? 15);
const BIG_LINES = Number(arg('big-lines') ?? 90);
const CONCURRENCY = Number(arg('concurrency') ?? 5);
const POOL_SIZE = arg('pool-size');
const WORKER_MODES: Array<'off' | 'on'> =
  arg('workers') === 'on' ? ['on'] : arg('workers') === 'off' ? ['off'] : ['off', 'on'];

export interface ScenarioResult {
  scenario: string; workers: string; duration_ms: number; files_per_sec: number;
  indexed: number; skipped: number; errors: number;
  rss_start_mb: number; rss_peak_mb: number; rss_delta_mb: number;
  /** Indexer-side phase breakdown (scan/analyze/embed/sweep + its own peak). */
  phases?: import('@mcp/shared/types.js').RunPhaseTelemetry;
}

/**
 * Return correctness failures that make throughput numbers meaningless.
 * No-change/touch-only scenarios may legitimately index zero files; cold and
 * changed-content scenarios may not. Any indexing error invalidates a run.
 */
export function validateScenarioResults(results: readonly ScenarioResult[]): string[] {
  const failures: string[] = [];
  for (const result of results) {
    const label = `${result.scenario} (${result.workers})`;
    if (result.errors > 0) {
      failures.push(`${label}: ${result.errors} indexing error(s)`);
    }
    if (
      (result.scenario === 'cold' || result.scenario === 'change_10pct') &&
      result.indexed === 0
    ) {
      failures.push(`${label}: indexed zero files`);
    }
  }
  return failures;
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
      ? bigFunctionFixture(`bigFn${i}`, BIG_LINES)
      : `${smallFileFixture(`fn${i}`)}\nexport const TAG_${i} = '${i}';\n`;
    writeFileSync(p, body, 'utf-8');
    paths.push(p);
  }
  return paths;
}

interface Bench {
  dir: string; root: string; projectId: number; db: CodeIndexDB; files: string[];
}

function setup(name: string): Bench {
  const dir = mkdtempSync(join(tmpdir(), `mcp-idx-bench-${name}-`));
  const root = join(dir, 'proj');
  mkdirSync(root);
  const files = writeFixture(root, FILE_COUNT);
  const db = new CodeIndexDB(join(dir, 'index.db'));
  const project = db.createProject(`bench-${name}`, root);
  return { dir, root, projectId: project.id, db, files };
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
    const res = await runStructuralIndex(b.db, b.projectId, {
      concurrency: CONCURRENCY,
      maxFileSizeKB: 200,
      ignorePatterns: [],
    });
    const durationMs = performance.now() - t0;
    const { startMb, peakMb } = sampler.stop();
    return {
      scenario: name, workers, duration_ms: Math.round(durationMs),
      files_per_sec: Math.round((res.totalFiles / Math.max(durationMs, 1)) * 1000),
      indexed: res.indexed, skipped: res.skipped, errors: res.errorCount,
      rss_start_mb: startMb, rss_peak_mb: peakMb, rss_delta_mb: peakMb - startMb,
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
  process.stderr.write(`Structural index bench — ${FILE_COUNT} files, concurrency ${CONCURRENCY}, workers=${WORKER_MODES.join('+')}\n`);
  const results: ScenarioResult[] = [];

  for (const mode of WORKER_MODES) {
    // Without --pool-size, 'on' keeps the production auto-size policy.
    process.env.MCP_INDEX_WORKERS = mode === 'on' ? (POOL_SIZE ?? 'on') : '0';
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
    file_count: FILE_COUNT, concurrency: CONCURRENCY, pipeline: 'structural',
    results,
  }, null, 2) + '\n', 'utf8');
  process.stderr.write(`\nResults written to ${file}\n`);

  const failures = validateScenarioResults(results);
  if (failures.length > 0) {
    throw new Error(`Invalid benchmark run:\n- ${failures.join('\n- ')}`);
  }
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
