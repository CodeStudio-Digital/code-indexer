/**
 * Baseline benchmark suite for the candidate-pipeline framework.
 *
 * Runs synthetic workloads on the public scorers/selectors/cache utilities
 * and prints p50/p95/p99 latency + throughput. The plan ("Fase 0: bench
 * baseline before any optimization") calls for these to land alongside
 * the framework so future optimizations can be measured against them.
 *
 * Run with:
 *   pnpm tsx packages/candidate-pipeline/bench/baseline.ts
 *
 * Output:
 *   - Console table with per-op stats
 *   - bench/results/baseline-YYYY-MM-DD.json (written to repo root)
 */
import { performance } from 'node:perf_hooks';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ESM equivalent of __dirname.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import {
  rrfMerge,
  weightedSum,
  cosineSimilarity,
  recencyDecay,
  batchFrequencyBoost,
  TopKSelector,
  DiversitySelector,
  BlenderSelector,
  LruCache,
  generateHyperplanes,
  generateMultiHashParams,
  computeLshEntry,
  bucketize,
  simHashSignature,
} from '../src/index.js';

interface BenchResult {
  op: string;
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

function bench(op: string, iterations: number, body: () => void): BenchResult {
  // Warm-up.
  for (let i = 0; i < Math.min(50, iterations); i++) body();
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
    op,
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

function randomEmbedding(dim: number): Float32Array {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = Math.random();
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) v[i] /= norm;
  return v;
}

// ────────────────────────────────────────────────────────────────────────
// Scenarios
// ────────────────────────────────────────────────────────────────────────

function benchRrfMerge(): BenchResult {
  const lists = [
    Array.from({ length: 200 }, (_, i) => ({ candidateId: `a${i}` })),
    Array.from({ length: 200 }, (_, i) => ({ candidateId: `b${(i + 50) % 200}` })),
  ];
  return bench('rrfMerge (200×2)', 5000, () => {
    rrfMerge([{ items: lists[0] }, { items: lists[1] }], { limit: 50 });
  });
}

function benchWeightedSum(): BenchResult {
  const signals = [
    { name: 'a', value: 0.8, weight: 1.0 },
    { name: 'b', value: 0.5, weight: 0.5 },
    { name: 'c', value: 0.2, weight: -0.3 },
    { name: 'd', value: 0.9, weight: 0.7 },
  ];
  return bench('weightedSum (4 signals)', 100_000, () => {
    weightedSum(signals);
  });
}

function benchCosineSimilarity(dim: number): BenchResult {
  const a = randomEmbedding(dim);
  const b = randomEmbedding(dim);
  return bench(`cosineSimilarity (dim=${dim})`, 50_000, () => {
    cosineSimilarity(a, b);
  });
}

function benchRecencyDecay(): BenchResult {
  const now = Date.now();
  return bench('recencyDecay', 200_000, () => {
    recencyDecay(now - 60_000, { halfLifeMs: 30_000, now });
  });
}

function benchFrequencyBoost(): BenchResult {
  const events = Array.from({ length: 200 }, (_, i) => ({
    candidateId: `tool_${i % 10}`,
    timestampMs: Date.now() - i * 100,
  }));
  const candidateIds = Array.from({ length: 20 }, (_, i) => `tool_${i}`);
  return bench('batchFrequencyBoost (20×200 events)', 5000, () => {
    batchFrequencyBoost(candidateIds, events, { windowMs: 60_000 });
  });
}

function benchTopKSelector(): BenchResult {
  const candidates = Array.from({ length: 500 }, (_, i) => ({ candidateId: `c${i}`, score: Math.random() }));
  const sel = new TopKSelector<never, { candidateId: string; score: number }>({
    k: 12,
    scoreOf: (c) => c.score,
  });
  return bench('TopKSelector (500 → 12)', 5000, () => {
    sel.select({} as never, candidates);
  });
}

function benchDiversitySelector(): BenchResult {
  const candidates = Array.from({ length: 200 }, (_, i) => ({
    candidateId: `c${i}`,
    group: `g${i % 8}`,
    score: Math.random(),
  }));
  const sel = new DiversitySelector<never, typeof candidates[0]>({
    k: 12,
    scoreOf: (c) => c.score,
    groupKey: (c) => c.group,
  });
  return bench('DiversitySelector (200 → 12, 8 groups)', 2000, () => {
    sel.select({} as never, candidates);
  });
}

function benchBlenderSelector(): BenchResult {
  const sel = new BlenderSelector<never, { candidateId: string; group: string; score: number }>({
    totalK: 15,
    tracks: [
      { name: 'a', items: Array.from({ length: 30 }, (_, i) => ({ candidateId: `a${i}`, group: 'a', score: 1 })) },
      { name: 'b', minSpacing: 3, cap: 5, items: Array.from({ length: 30 }, (_, i) => ({ candidateId: `b${i}`, group: 'b', score: 1 })) },
    ],
  });
  return bench('BlenderSelector (2 tracks, 30+30)', 2000, () => {
    sel.select({} as never, []);
  });
}

function benchLruCache(): BenchResult {
  const cache = new LruCache<string, number>({ maxSize: 1024 });
  let i = 0;
  return bench('LruCache get/set (maxSize=1024)', 200_000, () => {
    cache.set(`k${i & 4095}`, i);
    cache.get(`k${(i - 7) & 4095}`);
    i++;
  });
}

function benchLshSignature(dim: number): BenchResult {
  const planes = generateHyperplanes(dim, 32);
  const v = randomEmbedding(dim);
  return bench(`simHashSignature (dim=${dim}, 32 planes)`, 20_000, () => {
    simHashSignature(v, planes);
  });
}

function benchLshBucketize(): BenchResult {
  const params = generateMultiHashParams(4, 256);
  return bench('bucketize (4 hashes)', 200_000, () => {
    bucketize(0x12345678, params);
  });
}

function benchLshEntryFull(dim: number): BenchResult {
  const planes = generateHyperplanes(dim, 32);
  const params = generateMultiHashParams(4, 256);
  const v = randomEmbedding(dim);
  return bench(`computeLshEntry (dim=${dim})`, 10_000, () => {
    computeLshEntry('id', v, planes, params);
  });
}

// ────────────────────────────────────────────────────────────────────────
// Entrypoint
// ────────────────────────────────────────────────────────────────────────

function main(): void {
  console.log('candidate-pipeline baseline benchmark\n');
  const results: BenchResult[] = [
    benchRrfMerge(),
    benchWeightedSum(),
    benchCosineSimilarity(128),
    benchCosineSimilarity(768),
    benchRecencyDecay(),
    benchFrequencyBoost(),
    benchTopKSelector(),
    benchDiversitySelector(),
    benchBlenderSelector(),
    benchLruCache(),
    benchLshSignature(128),
    benchLshSignature(768),
    benchLshBucketize(),
    benchLshEntryFull(768),
  ];

  console.table(results);

  // Persist to disk for diff against future runs.
  const repoRoot = resolve(__dirname, '..', '..', '..');
  const outDir = join(repoRoot, 'bench', 'results');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const file = join(outDir, `baseline-${day}.json`);
  writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
  console.log(`\nResults written to ${file}`);
}

main();
