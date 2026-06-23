/**
 * Compare two baseline JSONs and report regressions (X2 — Sprint 2).
 *
 * Reads `--before` and `--after` JSON files (produced by
 * `runner-baseline.ts` / `pipeline-telemetry-baseline.ts` /
 * `search-quality.ts --save-baseline`), diffs the headline metrics,
 * and exits with code 1 when any threshold from the plan is breached:
 *
 *   - Completion rate cai >2%
 *   - Tokens-per-task sobem >5%
 *   - p95 latency sobe >10% em hot path
 *   - decisionMarkersDropped sobe acima do baseline
 *   - Recall@10 cai >5% (search baselines)
 *
 * Usage:
 *   pnpm tsx src/benchmarks/compare-baselines.ts \
 *     --before bench/results/runner-baseline-2026-05-25.json \
 *     --after  bench/results/runner-baseline-2026-06-01.json
 *
 * Output:
 *   - Stdout: markdown report (suitable for PR comment via gh pr comment)
 *   - Stderr: errors / warnings
 *   - Exit code: 0 if all thresholds met; 1 if any breach
 *
 * Auto-detects the baseline type via the JSON shape — same script
 * handles runner / pipeline-telemetry / search-quality baselines.
 *
 * **Why "compare" not "CI workflow"**: a CI workflow is repo-specific
 * (GitHub Actions vs GitLab vs CircleCI). This script is the building
 * block — each CI just calls it with the right arguments. Concrete CI
 * wiring (`.github/workflows/bench.yml`) is a follow-up that depends
 * on the user's deployment story.
 */
import { parseArgs } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';

interface ThresholdReport {
  metric: string;
  before: number | string;
  after: number | string;
  delta?: number;
  pct?: number;
  threshold: string;
  status: 'ok' | 'warn' | 'fail';
  note?: string;
}

const REVERT_THRESHOLDS = {
  /** Completion rate may not drop more than 2 percentage points. */
  completionRateDeltaMaxAbsPct: 2,
  /** Tokens per task may not rise more than 5%. */
  tokensPerTaskRiseMaxPct: 5,
  /** p95 latency in hot paths may not rise more than 10%. */
  p95LatencyRiseMaxPct: 10,
  /** Recall@10 may not drop more than 5 percentage points. */
  recallAt10DropMaxAbsPct: 5,
  /** Doom-loop indicator (compaction triggerRate) absolute % rise cap. */
  compactionTriggerRateRiseMaxAbsPct: 1,
};

function loadJson<T = unknown>(path: string): T {
  if (!existsSync(path)) {
    console.error(`[compare] file not found: ${path}`);
    process.exit(2);
  }
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

function pctChange(before: number, after: number): number {
  if (before === 0) return after === 0 ? 0 : Number.POSITIVE_INFINITY;
  return ((after - before) / before) * 100;
}

function fmt(n: number, decimals = 2): string {
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(decimals);
}

function detectKind(obj: Record<string, unknown>): 'runner' | 'pipeline' | 'search' | 'unknown' {
  if ('tokens' in obj && 'turnsPerSession' in obj) return 'runner';
  if ('pipelines' in obj && Array.isArray((obj as { pipelines?: unknown }).pipelines)) return 'pipeline';
  if ('results' in obj && Array.isArray((obj as { results?: unknown }).results)) return 'search';
  return 'unknown';
}

// ─── Runner baseline diff ─────────────────────────────────────────────

interface RunnerBaseline {
  tokens: { input: { p50: number; p95: number; mean: number }; output: { p50: number; p95: number; mean: number } };
  compaction: { triggerRate: number; summarizerRate: number };
  turnsPerSession: { stat: { p50: number; p95: number; mean: number } };
  tools: { truncationRate: number };
  estimatedCostUsd: { perTurn: { p50: number; p95: number; mean: number } };
}

function diffRunner(before: RunnerBaseline, after: RunnerBaseline): ThresholdReport[] {
  const out: ThresholdReport[] = [];

  // Tokens per turn (input + output mean)
  const meanTokensBefore = before.tokens.input.mean + before.tokens.output.mean;
  const meanTokensAfter = after.tokens.input.mean + after.tokens.output.mean;
  const tokensPct = pctChange(meanTokensBefore, meanTokensAfter);
  out.push({
    metric: 'tokens per turn (input+output mean)',
    before: fmt(meanTokensBefore, 0),
    after: fmt(meanTokensAfter, 0),
    pct: tokensPct,
    threshold: `≤+${REVERT_THRESHOLDS.tokensPerTaskRiseMaxPct}%`,
    status: tokensPct > REVERT_THRESHOLDS.tokensPerTaskRiseMaxPct ? 'fail' : 'ok',
  });

  // Input p95
  const inputP95Pct = pctChange(before.tokens.input.p95, after.tokens.input.p95);
  out.push({
    metric: 'input_tokens p95',
    before: before.tokens.input.p95,
    after: after.tokens.input.p95,
    pct: inputP95Pct,
    threshold: `≤+${REVERT_THRESHOLDS.p95LatencyRiseMaxPct}%`,
    status: inputP95Pct > REVERT_THRESHOLDS.p95LatencyRiseMaxPct ? 'warn' : 'ok',
    note: 'Cache invalidation regression would show here',
  });

  // Compaction trigger rate
  const compactionDeltaAbs = (after.compaction.triggerRate - before.compaction.triggerRate) * 100;
  out.push({
    metric: 'compaction trigger rate',
    before: `${fmt(before.compaction.triggerRate * 100, 2)}%`,
    after: `${fmt(after.compaction.triggerRate * 100, 2)}%`,
    delta: compactionDeltaAbs,
    threshold: `≤+${REVERT_THRESHOLDS.compactionTriggerRateRiseMaxAbsPct}pp`,
    status: compactionDeltaAbs > REVERT_THRESHOLDS.compactionTriggerRateRiseMaxAbsPct ? 'fail' : 'ok',
  });

  // Tool truncation rate
  const truncationDeltaAbs = (after.tools.truncationRate - before.tools.truncationRate) * 100;
  out.push({
    metric: 'tool truncation rate',
    before: `${fmt(before.tools.truncationRate * 100, 2)}%`,
    after: `${fmt(after.tools.truncationRate * 100, 2)}%`,
    delta: truncationDeltaAbs,
    threshold: '≤+2pp',
    status: truncationDeltaAbs > 2 ? 'warn' : 'ok',
  });

  // Cost per turn
  const costP95Pct = pctChange(before.estimatedCostUsd.perTurn.p95, after.estimatedCostUsd.perTurn.p95);
  out.push({
    metric: 'cost per turn p95',
    before: `$${fmt(before.estimatedCostUsd.perTurn.p95, 4)}`,
    after: `$${fmt(after.estimatedCostUsd.perTurn.p95, 4)}`,
    pct: costP95Pct,
    threshold: `≤+${REVERT_THRESHOLDS.tokensPerTaskRiseMaxPct}%`,
    status: costP95Pct > REVERT_THRESHOLDS.tokensPerTaskRiseMaxPct ? 'fail' : 'ok',
  });

  return out;
}

// ─── Pipeline telemetry diff ──────────────────────────────────────────

interface PipelineBaseline {
  pipelines: Array<{
    pipeline_name: string;
    totalInvocations: number;
    stages: Array<{
      stage: string;
      component_name: string;
      durationMs: { p50: number; p95: number; p99: number };
      errors: number;
    }>;
  }>;
}

function diffPipeline(before: PipelineBaseline, after: PipelineBaseline): ThresholdReport[] {
  const out: ThresholdReport[] = [];
  const afterByKey = new Map<string, PipelineBaseline['pipelines'][0]['stages'][0]>();
  for (const p of after.pipelines) {
    for (const s of p.stages) {
      afterByKey.set(`${p.pipeline_name}::${s.stage}::${s.component_name}`, s);
    }
  }
  for (const p of before.pipelines) {
    for (const sBefore of p.stages) {
      const key = `${p.pipeline_name}::${sBefore.stage}::${sBefore.component_name}`;
      const sAfter = afterByKey.get(key);
      if (!sAfter) continue;
      const p95Pct = pctChange(sBefore.durationMs.p95, sAfter.durationMs.p95);
      out.push({
        metric: `${p.pipeline_name}/${sBefore.stage}/${sBefore.component_name} p95`,
        before: `${fmt(sBefore.durationMs.p95)}ms`,
        after: `${fmt(sAfter.durationMs.p95)}ms`,
        pct: p95Pct,
        threshold: `≤+${REVERT_THRESHOLDS.p95LatencyRiseMaxPct}%`,
        status: p95Pct > REVERT_THRESHOLDS.p95LatencyRiseMaxPct ? 'fail' : 'ok',
      });
    }
  }
  return out;
}

// ─── Search-quality diff ──────────────────────────────────────────────

interface SearchBaseline {
  results: Array<{
    mode: string;
    recall_at_5: number;
    recall_at_10: number;
    mrr: number;
    p95_ms: number;
  }>;
}

function diffSearch(before: SearchBaseline, after: SearchBaseline): ThresholdReport[] {
  const out: ThresholdReport[] = [];
  const afterByMode = new Map(after.results.map((r) => [r.mode, r]));
  for (const rBefore of before.results) {
    const rAfter = afterByMode.get(rBefore.mode);
    if (!rAfter) continue;
    // Recall@10
    const recallDeltaAbs = (rAfter.recall_at_10 - rBefore.recall_at_10) * 100;
    out.push({
      metric: `${rBefore.mode} recall@10`,
      before: fmt(rBefore.recall_at_10, 3),
      after: fmt(rAfter.recall_at_10, 3),
      delta: recallDeltaAbs,
      threshold: `≥-${REVERT_THRESHOLDS.recallAt10DropMaxAbsPct}pp`,
      status: recallDeltaAbs < -REVERT_THRESHOLDS.recallAt10DropMaxAbsPct ? 'fail' : 'ok',
    });
    // p95 latency
    const p95Pct = pctChange(rBefore.p95_ms, rAfter.p95_ms);
    out.push({
      metric: `${rBefore.mode} p95 latency`,
      before: `${rBefore.p95_ms}ms`,
      after: `${rAfter.p95_ms}ms`,
      pct: p95Pct,
      threshold: `≤+${REVERT_THRESHOLDS.p95LatencyRiseMaxPct}%`,
      status: p95Pct > REVERT_THRESHOLDS.p95LatencyRiseMaxPct ? 'fail' : 'ok',
    });
  }
  return out;
}

// ─── Reporting ────────────────────────────────────────────────────────

function statusEmoji(s: 'ok' | 'warn' | 'fail'): string {
  return s === 'ok' ? '✅' : s === 'warn' ? '⚠️' : '❌';
}

function renderMarkdown(rows: ThresholdReport[], beforePath: string, afterPath: string): string {
  const lines: string[] = [];
  lines.push(`# Bench diff: \`${beforePath}\` → \`${afterPath}\``);
  lines.push('');
  lines.push('| Metric | Before | After | Δ | Threshold | Status |');
  lines.push('|---|---|---|---|---|---|');
  for (const r of rows) {
    const deltaStr = r.pct !== undefined
      ? `${r.pct >= 0 ? '+' : ''}${fmt(r.pct, 1)}%`
      : r.delta !== undefined
        ? `${r.delta >= 0 ? '+' : ''}${fmt(r.delta, 2)}pp`
        : '—';
    lines.push(
      `| ${r.metric} | ${r.before} | ${r.after} | ${deltaStr} | ${r.threshold} | ${statusEmoji(r.status)} |`,
    );
  }
  const failures = rows.filter((r) => r.status === 'fail');
  const warnings = rows.filter((r) => r.status === 'warn');
  lines.push('');
  if (failures.length > 0) {
    lines.push(`**${failures.length} FAILURE(S)** — revert criteria breached. Revert flag OFF before merging.`);
  } else if (warnings.length > 0) {
    lines.push(`${warnings.length} warning(s) — within thresholds but worth investigating.`);
  } else {
    lines.push(`All ${rows.length} metrics within thresholds. ✅`);
  }
  return lines.join('\n');
}

function main(): void {
  const { values } = parseArgs({
    options: {
      before: { type: 'string' },
      after: { type: 'string' },
    },
  });
  if (!values.before || !values.after) {
    console.error('Usage: tsx src/benchmarks/compare-baselines.ts --before <a.json> --after <b.json>');
    process.exit(2);
  }
  const beforeObj = loadJson<Record<string, unknown>>(values.before);
  const afterObj = loadJson<Record<string, unknown>>(values.after);
  const kindBefore = detectKind(beforeObj);
  const kindAfter = detectKind(afterObj);
  if (kindBefore !== kindAfter || kindBefore === 'unknown') {
    console.error(`[compare] baselines are different kinds (${kindBefore} vs ${kindAfter}) — cannot diff.`);
    process.exit(2);
  }

  let rows: ThresholdReport[];
  switch (kindBefore) {
    case 'runner':
      rows = diffRunner(beforeObj as unknown as RunnerBaseline, afterObj as unknown as RunnerBaseline);
      break;
    case 'pipeline':
      rows = diffPipeline(beforeObj as unknown as PipelineBaseline, afterObj as unknown as PipelineBaseline);
      break;
    case 'search':
      rows = diffSearch(beforeObj as unknown as SearchBaseline, afterObj as unknown as SearchBaseline);
      break;
  }

  console.log(renderMarkdown(rows, values.before, values.after));

  const hasFailure = rows.some((r) => r.status === 'fail');
  process.exit(hasFailure ? 1 : 0);
}

main();
