/**
 * Hot State Cache — decision-gate benchmark.
 *
 * The cache exists today but no production code reads from it. Before
 * wiring `BoardBridge.read` (or any other read path) cache-first, we
 * need to know: HOW MUCH does SQLite actually cost for the read patterns
 * we care about? If the answer is "almost nothing", the cache should be
 * deleted; if it's "noticeable", wiring it pays off.
 *
 * This bench measures the two scenarios that actually happen in
 * production:
 *
 *   - **Tail polling**: master polls `readBoard({ sinceId: last, limit: 50 })`
 *     every few seconds. Most common read; this is what would benefit
 *     most from a hot cache.
 *   - **Initial load**: dashboard opens a session, fetches `readBoard({
 *     limit: 100 })`. Rare per session but happens at session-resume time.
 *
 * For each scenario we benchmark:
 *
 *   1. **sqlite_only**       — current behavior, every read hits SQLite.
 *   2. **cache_warm**        — every read served from the in-memory cache.
 *   3. **cache_partial_miss** — half the entries are in cache, half need SQLite.
 *
 * Output:
 *   - Console table with p50/p95/p99 + ops/sec
 *   - `bench/results/hot-state-cache-baseline-YYYY-MM-DD.json` for tracking
 *   - **Recommendation** line at the bottom that names the next step:
 *     * p95 SQLite < 5ms        → DELETE cache (overhead > benefit)
 *     * p95 SQLite > 20ms       → WIRE cache everywhere
 *     * 5–20ms                  → WIRE only `BoardBridge.read` first
 *
 * Run:
 *   pnpm tsx packages/candidate-pipeline/bench/bench-hot-state-cache.ts
 */
import { performance } from 'node:perf_hooks';
import { writeFileSync, mkdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { CodeIndexDB } from '@mcp/store/db.js';
import { CompanyStore } from '@mcp/store/company-store.js';
import { HotStateCache } from '@mcp/services/hot-state-cache/index.js';
import type { BoardEntry } from '@mcp/company/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Tunables ───────────────────────────────────────────────────────────
const SEED_ENTRY_COUNT = 500;       // total board entries persisted
const TAIL_LIMIT = 50;              // master polls 50 entries per tick
const INITIAL_LIMIT = 100;          // dashboard fetches 100 on session open
const ITER_TAIL = 2_000;            // bench iterations for tail-polling
const ITER_INITIAL = 1_000;         // bench iterations for initial-load
const WARM_UP_ITERS = 50;

interface BenchResult {
  scenario: string;
  iterations: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  ops_per_sec: number;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q));
  return sorted[pos];
}

function bench(scenario: string, iterations: number, body: () => void): BenchResult {
  for (let i = 0; i < Math.min(WARM_UP_ITERS, iterations); i++) body();
  const samples: number[] = new Array(iterations);
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    body();
    samples[i] = performance.now() - t0;
  }
  const elapsedMs = performance.now() - start;
  samples.sort((a, b) => a - b);
  return {
    scenario,
    iterations,
    p50_ms: round(quantile(samples, 0.5), 4),
    p95_ms: round(quantile(samples, 0.95), 4),
    p99_ms: round(quantile(samples, 0.99), 4),
    ops_per_sec: Math.round((iterations / elapsedMs) * 1000),
  };
}

function round(n: number, decimals: number): number {
  const p = Math.pow(10, decimals);
  return Math.round(n * p) / p;
}

// ─── Setup: temp DB + company session + 500 board entries ────────────────

interface Harness {
  dbDir: string;
  db: CodeIndexDB;
  companyStore: CompanyStore;
  cache: HotStateCache;
  sessionId: number;
  entryIds: number[]; // ASC order of inserted ids
}

function setupHarness(): Harness {
  const dbDir = mkdtempSync(join(tmpdir(), 'mcp-hotcache-bench-'));
  const dbPath = join(dbDir, 'test.db');
  const db = new CodeIndexDB(dbPath);
  const companyStore = new CompanyStore(dbPath);
  const cache = new HotStateCache({
    streams: { 'company::board': { maxEntries: 1_000, retentionMs: 24 * 60 * 60 * 1000 } },
    autoTrimIntervalMs: 0, // bench-only — no background timer noise
  });
  const session = companyStore.createCompanySession({ name: 'bench' });
  const entryIds: number[] = [];
  for (let i = 0; i < SEED_ENTRY_COUNT; i++) {
    const entry = companyStore.postToBoard(
      session.id,
      i % 4 === 0 ? 'frontend' : 'backend',
      null,
      'message',
      `board entry #${i} with some realistic payload content of moderate length`,
      i % 5 === 0 ? ['master'] : [],
    );
    entryIds.push(entry.id);
    // Mirror what the production write-through does — populate the cache
    // for the warm/partial-miss scenarios.
    cache.put<BoardEntry>(String(session.id), 'company', 'board', String(entry.id), entry);
  }
  return { dbDir, db, companyStore, cache, sessionId: session.id, entryIds };
}

function teardown(h: Harness): void {
  try { h.companyStore.close(); } catch { /* */ }
  try { h.db.close(); } catch { /* */ }
  try { rmSync(h.dbDir, { recursive: true, force: true }); } catch { /* */ }
}

// ─── Cache-first read implementation that BoardBridge WOULD use ──────────
//
// Mirrors the would-be `BoardBridge.read` cache-fast-path:
//   1. Cache walks newest-first via readRecent.
//   2. Filter to entries with id > sinceId (or all if no sinceId).
//   3. Cache covers the request if (a) we got `limit` entries, OR (b) we
//      walked all the way to an entry with id <= sinceId — meaning we
//      know there's nothing newer waiting in SQLite.
//   4. On miss/incomplete coverage, fall back to SQLite.

function cacheCoversWindow(
  cached: BoardEntry[],
  sinceId: number | undefined,
  limit: number,
): boolean {
  if (cached.length >= limit) return true; // got our quota
  if (sinceId == null) return false; // need exactly `limit` newest; cache had fewer
  // We walked the cache newest-first and stopped early. Coverage requires
  // that the OLDEST entry in our result has id == sinceId + 1, OR the
  // cache contains entries older than sinceId (proving nothing was missed
  // between the cache's tail and sinceId).
  if (cached.length === 0) return false;
  // Heuristic: if cache contains any entry with id <= sinceId, we've seen
  // the "boundary" and missed nothing. Approximate by checking if any
  // entry in the cache's underlying deque is <= sinceId. Without that
  // visibility from outside, accept partial cache when at least 1 result.
  // For bench purposes we assume cache is large enough (1_000 cap > 500
  // seed) so this is always true; for real production we'd add a coverage
  // probe to readRecent.
  return cached.length > 0;
}

function readBoardCacheFirst(
  h: Harness,
  opts: { sinceId?: number; limit: number },
): BoardEntry[] {
  // Cache returns newest-first. Walk up to `limit + slack` to allow
  // filtering by sinceId.
  const cached = h.cache.readRecent<BoardEntry>(
    String(h.sessionId),
    'company',
    'board',
    { limit: opts.limit * 2 },
  );
  const filtered = opts.sinceId != null
    ? cached.filter((e) => e.id > opts.sinceId!)
    : cached;
  if (cacheCoversWindow(filtered.slice(0, opts.limit), opts.sinceId, opts.limit)) {
    // SQLite returns ASC; cache walked DESC — reverse for parity.
    return filtered.slice(0, opts.limit).reverse();
  }
  // Cache miss / window-too-wide — fall through to SQLite.
  return h.companyStore.readBoard(h.sessionId, opts);
}

// ─── Scenarios ──────────────────────────────────────────────────────────

function scenarioTailPollingSqliteOnly(h: Harness): BenchResult {
  // Master polls "give me everything since the last entry I saw". On a
  // typical tick there are 0 new entries → SQLite returns []. Worst case
  // there's a burst of 1-5. We seed sinceId to "last entry id" so the
  // bench measures the steady-state cost.
  const sinceId = h.entryIds[h.entryIds.length - 1];
  return bench('tail_polling.sqlite_only', ITER_TAIL, () => {
    h.companyStore.readBoard(h.sessionId, { sinceId, limit: TAIL_LIMIT });
  });
}

function scenarioTailPollingCacheWarm(h: Harness): BenchResult {
  const sinceId = h.entryIds[h.entryIds.length - 1];
  return bench('tail_polling.cache_warm', ITER_TAIL, () => {
    readBoardCacheFirst(h, { sinceId, limit: TAIL_LIMIT });
  });
}

function scenarioInitialLoadSqliteOnly(h: Harness): BenchResult {
  // Dashboard opens — fetch last 100 entries with no sinceId.
  return bench('initial_load.sqlite_only', ITER_INITIAL, () => {
    h.companyStore.readBoard(h.sessionId, { limit: INITIAL_LIMIT });
  });
}

function scenarioInitialLoadCacheWarm(h: Harness): BenchResult {
  return bench('initial_load.cache_warm', ITER_INITIAL, () => {
    readBoardCacheFirst(h, { limit: INITIAL_LIMIT });
  });
}

function scenarioTailPollingCacheMissCold(h: Harness): BenchResult {
  // Cold-cache scenario: use a brand-new HotStateCache (no entries cached).
  // This is what happens immediately after server restart — until the
  // cache warms up, EVERY tail-poll cache lookup misses and falls back
  // to SQLite. We measure the overhead of the cache miss path itself.
  const coldCache = new HotStateCache({
    streams: { 'company::board': { maxEntries: 1_000, retentionMs: 24 * 60 * 60 * 1000 } },
    autoTrimIntervalMs: 0,
  });
  const sinceId = h.entryIds[h.entryIds.length - 1];
  const coldHarness: Harness = { ...h, cache: coldCache };
  return bench('tail_polling.cache_cold_miss', ITER_TAIL, () => {
    readBoardCacheFirst(coldHarness, { sinceId, limit: TAIL_LIMIT });
  });
}

// ─── Recommendation logic ───────────────────────────────────────────────

interface Recommendation {
  decision: 'delete' | 'wire_board_only' | 'wire_everywhere';
  rationale: string;
  numbers: { tail_sqlite_p95_ms: number; tail_cache_p95_ms: number; delta_ms: number; delta_pct: number };
}

function recommendation(results: BenchResult[]): Recommendation {
  const tailSqlite = results.find((r) => r.scenario === 'tail_polling.sqlite_only')!;
  const tailCache  = results.find((r) => r.scenario === 'tail_polling.cache_warm')!;
  const sqliteP95 = tailSqlite.p95_ms;
  const cacheP95 = tailCache.p95_ms;
  const deltaMs = sqliteP95 - cacheP95;
  const deltaPct = sqliteP95 > 0 ? round((deltaMs / sqliteP95) * 100, 1) : 0;

  let decision: Recommendation['decision'];
  let rationale: string;
  if (sqliteP95 < 5) {
    decision = 'delete';
    rationale = `SQLite p95 (${sqliteP95}ms) is already <5ms — the cache adds complexity without measurable benefit. Delete the cache (Caminho B in the plan).`;
  } else if (sqliteP95 > 20) {
    decision = 'wire_everywhere';
    rationale = `SQLite p95 (${sqliteP95}ms) is >20ms — significant hot-path cost. Wire BoardBridge + KanbanService + InboxQueue reads cache-first.`;
  } else {
    decision = 'wire_board_only';
    rationale = `SQLite p95 (${sqliteP95}ms) is in the 5-20ms band. Wire only the hottest read (BoardBridge tail polling, ~${deltaPct}% faster with cache) and re-measure after 1 week.`;
  }
  return { decision, rationale, numbers: { tail_sqlite_p95_ms: sqliteP95, tail_cache_p95_ms: cacheP95, delta_ms: deltaMs, delta_pct: deltaPct } };
}

// ─── Main ────────────────────────────────────────────────────────────────

function main(): void {
  process.stderr.write('Hot State Cache decision-gate benchmark\n');
  process.stderr.write(`Seeding ${SEED_ENTRY_COUNT} board entries in a temp SQLite + cache…\n`);

  const h = setupHarness();
  try {
    const results: BenchResult[] = [
      scenarioTailPollingSqliteOnly(h),
      scenarioTailPollingCacheWarm(h),
      scenarioTailPollingCacheMissCold(h),
      scenarioInitialLoadSqliteOnly(h),
      scenarioInitialLoadCacheWarm(h),
    ];

    process.stderr.write('\n');
    process.stderr.write('Scenario'.padEnd(40) +
      'p50 (ms)'.padStart(12) +
      'p95 (ms)'.padStart(12) +
      'p99 (ms)'.padStart(12) +
      'ops/sec'.padStart(14) + '\n');
    process.stderr.write('─'.repeat(90) + '\n');
    for (const r of results) {
      process.stderr.write(
        r.scenario.padEnd(40) +
        String(r.p50_ms).padStart(12) +
        String(r.p95_ms).padStart(12) +
        String(r.p99_ms).padStart(12) +
        String(r.ops_per_sec).padStart(14) + '\n',
      );
    }

    const rec = recommendation(results);
    process.stderr.write('\n');
    process.stderr.write('─'.repeat(90) + '\n');
    process.stderr.write(`Decision: ${rec.decision.toUpperCase()}\n`);
    process.stderr.write(`Rationale: ${rec.rationale}\n`);
    process.stderr.write(`Numbers: tail SQLite p95=${rec.numbers.tail_sqlite_p95_ms}ms, tail cache p95=${rec.numbers.tail_cache_p95_ms}ms, delta=${rec.numbers.delta_ms}ms (${rec.numbers.delta_pct}%)\n`);

    // Persist for tracking.
    const repoRoot = resolve(__dirname, '../../..');
    const resultsDir = join(repoRoot, 'bench', 'results');
    if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = join(resultsDir, `hot-state-cache-baseline-${stamp}.json`);
    writeFileSync(filename, JSON.stringify({
      generated_at: new Date().toISOString(),
      seed_entry_count: SEED_ENTRY_COUNT,
      results,
      recommendation: rec,
    }, null, 2) + '\n', 'utf8');
    process.stderr.write(`\nResults written to ${filename}\n`);
  } finally {
    teardown(h);
  }
}

main();
