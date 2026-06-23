/**
 * Pipeline telemetry baseline — aggregates `pipeline_telemetry` rows per
 * (pipeline_name, stage, component_name) so we can diff stage latency,
 * cache hit rate, error rate, and candidate fan-out after any pipeline change.
 *
 * Zero LLM calls, zero network — pure SQL over existing telemetry.
 *
 * Usage:
 *   pnpm tsx src/benchmarks/pipeline-telemetry-baseline.ts
 *   pnpm tsx src/benchmarks/pipeline-telemetry-baseline.ts --since 2026-04-01
 *   pnpm tsx src/benchmarks/pipeline-telemetry-baseline.ts --pipeline tool_selection
 *
 * Output:
 *   - Console table per pipeline_name (stages, latency, cache, errors)
 *   - bench/results/pipeline-telemetry-baseline-YYYY-MM-DD.json
 *
 * Captures (per the plan's Verificação section):
 *   - p50/p95/p99 duration per stage/component
 *   - cache hit rate per stage/component
 *   - candidates_in/out distribution (fan-out)
 *   - error count per stage/component
 *
 * Diff baseline vs post-change to enforce ≤5% p95 regression in hot paths
 * (CandidatePipeline framework migration of HybridSearch in I1).
 */
import { parseArgs } from 'node:util';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '@mcp/shared/utils/config.js';
import { CodeIndexDB } from '@mcp/store/db.js';
import { PipelineTelemetryStore } from '@mcp/store/pipeline-telemetry-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface StageStat {
  pipeline_name: string;
  stage: string;
  component_name: string;
  invocations: number;
  durationMs: { p50: number; p95: number; p99: number; mean: number; min: number; max: number };
  candidatesIn: { p50: number; p95: number; mean: number } | null;
  candidatesOut: { p50: number; p95: number; mean: number } | null;
  cache: { hits: number; misses: number; hitRate: number } | null;
  errors: number;
}

interface PipelineSummary {
  pipeline_name: string;
  totalInvocations: number;
  stages: StageStat[];
  durationByBucket: Array<{ bucket: string; count: number }>;
}

interface PipelineBaseline {
  generatedAt: string;
  schemaVersion: number;
  filters: { since?: string; pipeline?: string };
  totalRows: number;
  pipelines: PipelineSummary[];
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q));
  return sorted[pos];
}

function statsOf(values: number[]): {
  p50: number;
  p95: number;
  p99: number;
  mean: number;
  min: number;
  max: number;
} {
  if (values.length === 0) {
    return { p50: 0, p95: 0, p99: 0, mean: 0, min: 0, max: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const total = values.reduce((a, b) => a + b, 0);
  return {
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    mean: total / values.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

function fmt(n: number, decimals = 2): string {
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(decimals);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      since: { type: 'string' },
      pipeline: { type: 'string' },
      output: { type: 'string' },
      'db-path': { type: 'string' },
    },
  });

  const config = loadConfig();
  const dbPath = values['db-path'] ?? config.dbPath;
  if (!existsSync(dbPath)) {
    console.error(`[pipeline-baseline] DB not found: ${dbPath}`);
    process.exit(1);
  }
  console.log(`[pipeline-baseline] DB: ${dbPath}`);

  const handle = new CodeIndexDB(dbPath);
  const db = handle.raw();

  // Detect missing table — pipeline_telemetry came in migration 085.
  const tableRow = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='pipeline_telemetry'`)
    .get() as { name?: string } | undefined;
  if (!tableRow?.name) {
    console.error(
      '[pipeline-baseline] pipeline_telemetry table missing — no pipeline has emitted telemetry yet.',
    );
    process.exit(1);
  }

  const since = values.since ?? null;
  const pipelineFilter = values.pipeline ?? null;
  console.log(`[pipeline-baseline] since: ${since ?? 'all-time'}  pipeline: ${pipelineFilter ?? 'all'}`);

  const store = new PipelineTelemetryStore(db);

  // ── Discover pipeline names ───────────────────────────────────────────
  const whereParts: string[] = [];
  if (since) whereParts.push(`created_at >= '${since.replace(/'/g, "''")}'`);
  if (pipelineFilter) whereParts.push(`pipeline_name = '${pipelineFilter.replace(/'/g, "''")}'`);
  const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';

  const pipelineNames = (
    db
      .prepare(`SELECT DISTINCT pipeline_name FROM pipeline_telemetry ${whereSql} ORDER BY pipeline_name`)
      .all() as Array<{ pipeline_name: string }>
  ).map((r) => r.pipeline_name);

  if (pipelineNames.length === 0) {
    console.error('[pipeline-baseline] no rows match — nothing to baseline.');
    process.exit(1);
  }
  console.log(`[pipeline-baseline] pipelines: ${pipelineNames.join(', ')}`);

  const totalRowsRow = db
    .prepare(`SELECT COUNT(*) AS total FROM pipeline_telemetry ${whereSql}`)
    .get() as { total: number };

  // ── Per pipeline: stage-level aggregates ─────────────────────────────
  const pipelines: PipelineSummary[] = [];
  for (const name of pipelineNames) {
    const stageRows = db
      .prepare(
        `SELECT stage, component_name, COUNT(*) AS invocations,
                SUM(cache_hits) AS cache_hits,
                SUM(cache_misses) AS cache_misses,
                SUM(errors) AS errors
         FROM pipeline_telemetry
         WHERE pipeline_name = ? ${since ? `AND created_at >= ?` : ''}
         GROUP BY stage, component_name
         ORDER BY stage, component_name`,
      )
      .all(...[name, ...(since ? [since] : [])]) as Array<{
      stage: string;
      component_name: string;
      invocations: number;
      cache_hits: number;
      cache_misses: number;
      errors: number;
    }>;

    const totalInvocations = stageRows.reduce((a, r) => a + r.invocations, 0);

    const stages: StageStat[] = stageRows.map((r) => {
      // Per-stage value vectors. Bounded by invocations — usually small.
      const valsParams: unknown[] = [name, r.stage, r.component_name];
      let valsClause = '';
      if (since) {
        valsClause = `AND created_at >= ?`;
        valsParams.push(since);
      }
      const dataRows = db
        .prepare(
          `SELECT duration_ms, candidates_in, candidates_out
           FROM pipeline_telemetry
           WHERE pipeline_name = ? AND stage = ? AND component_name = ? ${valsClause}`,
        )
        .all(...valsParams) as Array<{
        duration_ms: number;
        candidates_in: number | null;
        candidates_out: number | null;
      }>;

      const durations = dataRows.map((d) => d.duration_ms);
      const ins = dataRows.map((d) => d.candidates_in).filter((v): v is number => typeof v === 'number');
      const outs = dataRows.map((d) => d.candidates_out).filter((v): v is number => typeof v === 'number');

      const cacheTotal = r.cache_hits + r.cache_misses;
      return {
        pipeline_name: name,
        stage: r.stage,
        component_name: r.component_name,
        invocations: r.invocations,
        durationMs: statsOf(durations),
        candidatesIn: ins.length > 0 ? { p50: quantile([...ins].sort((a, b) => a - b), 0.5), p95: quantile([...ins].sort((a, b) => a - b), 0.95), mean: ins.reduce((a, b) => a + b, 0) / ins.length } : null,
        candidatesOut: outs.length > 0 ? { p50: quantile([...outs].sort((a, b) => a - b), 0.5), p95: quantile([...outs].sort((a, b) => a - b), 0.95), mean: outs.reduce((a, b) => a + b, 0) / outs.length } : null,
        cache: cacheTotal > 0 ? { hits: r.cache_hits, misses: r.cache_misses, hitRate: r.cache_hits / cacheTotal } : null,
        errors: r.errors,
      };
    });

    const durationByBucket = store.histogram({
      pipelineName: name,
      bucketField: 'duration_bucket',
      ...(since ? { since } : {}),
    });

    pipelines.push({
      pipeline_name: name,
      totalInvocations,
      stages,
      durationByBucket,
    });
  }

  const baseline: PipelineBaseline = {
    generatedAt: new Date().toISOString(),
    schemaVersion: handle.getSchemaVersion(),
    filters: {
      since: since ?? undefined,
      pipeline: pipelineFilter ?? undefined,
    },
    totalRows: totalRowsRow.total,
    pipelines,
  };

  // ── Console summary ───────────────────────────────────────────────────
  console.log(`\n[pipeline-baseline] total rows: ${baseline.totalRows}`);
  for (const p of baseline.pipelines) {
    console.log(`\n=== ${p.pipeline_name} (invocations=${p.totalInvocations}) ===`);
    const header = `  ${'stage'.padEnd(16)} ${'component'.padEnd(26)} ${'n'.padStart(6)} ${'p50ms'.padStart(8)} ${'p95ms'.padStart(8)} ${'p99ms'.padStart(8)} ${'cIn(p50/p95)'.padStart(14)} ${'cOut(p50/p95)'.padStart(15)} ${'cache'.padStart(10)} ${'err'.padStart(5)}`;
    console.log(header);
    for (const s of p.stages) {
      const cIn = s.candidatesIn ? `${fmt(s.candidatesIn.p50, 0)}/${fmt(s.candidatesIn.p95, 0)}` : '—';
      const cOut = s.candidatesOut ? `${fmt(s.candidatesOut.p50, 0)}/${fmt(s.candidatesOut.p95, 0)}` : '—';
      const cache = s.cache ? `${fmt(s.cache.hitRate * 100, 1)}%` : '—';
      console.log(
        `  ${s.stage.padEnd(16)} ${s.component_name.padEnd(26)} ${String(s.invocations).padStart(6)} ${fmt(s.durationMs.p50).padStart(8)} ${fmt(s.durationMs.p95).padStart(8)} ${fmt(s.durationMs.p99).padStart(8)} ${cIn.padStart(14)} ${cOut.padStart(15)} ${cache.padStart(10)} ${String(s.errors).padStart(5)}`,
      );
    }
    if (p.durationByBucket.length > 0) {
      console.log(`  duration buckets:`);
      for (const b of p.durationByBucket) {
        console.log(`    ${b.bucket.padEnd(12)} ${String(b.count).padStart(6)}`);
      }
    }
  }

  // ── Persist ───────────────────────────────────────────────────────────
  const repoRoot = resolve(__dirname, '..', '..');
  const outDir = join(repoRoot, 'bench', 'results');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const outPath = values.output ?? join(outDir, `pipeline-telemetry-baseline-${day}.json`);
  writeFileSync(outPath, JSON.stringify(baseline, null, 2));
  console.log(`\n[pipeline-baseline] written to ${outPath}`);

  handle.close();
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
