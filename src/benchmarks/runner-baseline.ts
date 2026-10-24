/**
 * Runner baseline — aggregates immutable turn metrics from filesystem session
 * bundles into a snapshot we can diff against after any agent change.
 *
 * Zero tokens spent: this script ONLY reads what the runner already wrote
 * during real usage. It does NOT invoke the agent.
 *
 * Usage:
 *   pnpm tsx src/benchmarks/runner-baseline.ts
 *   pnpm tsx src/benchmarks/runner-baseline.ts --since 2026-04-01
 *   pnpm tsx src/benchmarks/runner-baseline.ts --output bench/results/custom.json
 *
 * Output:
 *   - Console table with the headline numbers
 *   - bench/results/runner-baseline-YYYY-MM-DD.json
 *
 * Captures (per the plan's Verificação section):
 *   - tokens-per-turn (input/output/cache/thinking) p50/p95/total
 *   - turns-per-session p50/p95/p99 (proxy for completion)
 *   - compaction & summarizer trigger rate
 *   - tool-call distribution from per-turn metrics
 *   - estimated_cost_usd
 *
 * Re-run this AFTER any agent change and diff vs the baseline JSON. Any
 * regression listed in the plan's "Critérios de revert" → flag OFF.
 */
import { parseArgs } from 'node:util';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, mcpDataDir } from '@mcp/shared/utils/config.js';
import { CodeIndexDB } from '@mcp/store/db.js';
import { FsSessionStore } from '@mcp/session-storage/fs-store/fs-session-store.js';
import {
  listFilesystemTurnTelemetry,
  telemetryTools,
  type FsTurnTelemetryRow,
} from '@mcp/session-storage/fs-store/telemetry-dashboard.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface NumStat {
  count: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  total: number;
}

interface ToolRow {
  tool_name: string;
  calls: number;
  avg_output_chars: number;
  p95_output_chars: number;
  truncated_rate: number;
}

interface PhaseRow {
  phase: string | null;
  count: number;
  share: number;
}

interface Histogram {
  bucket: string;
  count: number;
}

interface RunnerBaseline {
  generatedAt: string;
  schemaVersion: number;
  filters: { since?: string };
  summary: {
    totalRows: number;
    distinctSessions: number;
    distinctRuns: number;
    mainAgentTurns: number;
    subagentTurns: number;
    dateRange: { from: string | null; to: string | null };
  };
  tokens: {
    input: NumStat;
    output: NumStat;
    cacheRead: NumStat;
    cacheCreation: NumStat;
    thinking: NumStat;
  };
  context: {
    historyChars: NumStat;
    systemPromptChars: NumStat;
    toolsDefChars: NumStat;
    largestToolResultChars: NumStat;
  };
  compaction: {
    triggerRate: number;
    summarizerRate: number;
    paginateCount: NumStat;
  };
  tools: {
    totalCalls: number;
    truncationRate: number;
    top20ByCount: ToolRow[];
    phaseDistribution: PhaseRow[];
  };
  turnsPerSession: {
    stat: NumStat;
    histogram: Histogram[];
  };
  estimatedCostUsd: {
    totalAllTime: number;
    perTurn: NumStat;
  };
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q));
  return sorted[pos];
}

function statFrom(values: number[]): NumStat {
  if (values.length === 0) {
    return { count: 0, min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0, total: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const total = values.reduce((a, b) => a + b, 0);
  return {
    count: values.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: total / values.length,
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    total,
  };
}

function turnsHistogram(turnCounts: number[]): Histogram[] {
  // Buckets aligned with how a user thinks about agent length.
  const buckets = [
    { label: '1', test: (n: number) => n === 1 },
    { label: '2-3', test: (n: number) => n >= 2 && n <= 3 },
    { label: '4-7', test: (n: number) => n >= 4 && n <= 7 },
    { label: '8-15', test: (n: number) => n >= 8 && n <= 15 },
    { label: '16-30', test: (n: number) => n >= 16 && n <= 30 },
    { label: '31-60', test: (n: number) => n >= 31 && n <= 60 },
    { label: '61+', test: (n: number) => n >= 61 },
  ];
  return buckets.map((b) => ({ bucket: b.label, count: turnCounts.filter((t) => b.test(t)).length }));
}

function fmt(n: number, decimals = 1): string {
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(decimals);
}

function logStat(label: string, s: NumStat, unit = ''): void {
  if (s.count === 0) {
    console.log(`  ${label.padEnd(28)} n=0 (no data)`);
    return;
  }
  console.log(
    `  ${label.padEnd(28)} n=${s.count}  p50=${fmt(s.p50)}${unit}  p95=${fmt(s.p95)}${unit}  p99=${fmt(s.p99)}${unit}  mean=${fmt(s.mean)}${unit}  total=${fmt(s.total, 0)}${unit}`,
  );
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      since: { type: 'string' },
      output: { type: 'string' },
      'db-path': { type: 'string' },
    },
  });

  const config = loadConfig();
  const dbPath = values['db-path'] ?? config.dbPath;
  if (!existsSync(dbPath)) {
    console.error(`[runner-baseline] DB not found: ${dbPath}`);
    process.exit(1);
  }
  console.log(`[runner-baseline] DB: ${dbPath}`);

  const handle = new CodeIndexDB(dbPath);
  const since = values.since ?? null;
  console.log(`[runner-baseline] since: ${since ?? 'all-time'}`);
  const sessionStore = FsSessionStore.fromRoots({
    dataDir: mcpDataDir(),
    projectRootResolver: {
      resolveProjectRoot: (projectId) =>
        handle.getProject(projectId)?.root_path,
      listProjectRoots: () =>
        handle.listProjects().map((project) => ({
          project_id: project.id,
          root_path: project.root_path,
        })),
    },
  });
  await sessionStore.ensureCatalog();
  const sinceMs = since == null ? Number.NaN : Date.parse(since);
  if (since != null && !Number.isFinite(sinceMs)) {
    throw new Error('--since must be a valid ISO timestamp');
  }
  const turnsBySession = await Promise.all(
    sessionStore.catalog.list().map(async (entry) => ({
      sessionId: entry.session.id,
      turns: (
        await listFilesystemTurnTelemetry(
          sessionStore,
          entry.session.id,
        )
      ).filter(
        (turn) =>
          !Number.isFinite(sinceMs) ||
          Date.parse(turn.created_at) >= sinceMs,
      ),
    })),
  );
  const turns = turnsBySession
    .flatMap((session) => session.turns)
    .sort(
      (left, right) =>
        left.created_at.localeCompare(right.created_at) ||
        left.id.localeCompare(right.id),
    );

  if (turns.length === 0) {
    console.error(
      `[runner-baseline] no filesystem turn metrics${since ? ` since ${since}` : ''} — nothing to baseline.`,
    );
    process.exit(1);
  }

  const sessionIds = new Set<string>();
  const runIds = new Set<string>();
  for (const t of turns) {
    sessionIds.add(t.session_id);
    runIds.add(t.run_id);
  }

  // Numeric vectors with NULLs filtered out — we measure where the field
  // was populated, not artificially deflate the mean with zeros.
  const pickNum = (key: keyof FsTurnTelemetryRow): number[] =>
    turns
      .map((t) => t[key])
      .filter((v): v is number => typeof v === 'number');

  // ── Tools aggregates ──────────────────────────────────────────────────
  let topToolsRows: ToolRow[] = [];
  let phaseRows: PhaseRow[] = [];
  let totalToolCalls = turns.reduce(
    (total, turn) => total + turn.tool_count,
    0,
  );
  let truncationRate = 0;
  const toolCounts = new Map<string, number>();
  for (const turn of turns) {
    for (const tool of telemetryTools(turn.tools_called)) {
      toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);
    }
  }
  topToolsRows = [...toolCounts]
    .map(([tool_name, calls]) => ({
      tool_name,
      calls,
      // Per-call payload size/truncation moved to tool output artifacts. Turn
      // metrics intentionally expose only the aggregate largest payload.
      avg_output_chars: 0,
      p95_output_chars: 0,
      truncated_rate: 0,
    }))
    .sort(
      (left, right) =>
        right.calls - left.calls ||
        left.tool_name.localeCompare(right.tool_name),
    )
    .slice(0, 20);
  if (totalToolCalls === 0) {
    totalToolCalls = [...toolCounts.values()].reduce(
      (total, calls) => total + calls,
      0,
    );
  }

  // ── Turns-per-session distribution ────────────────────────────────────
  const turnCounts = turnsBySession
    .map((session) => session.turns.length)
    .filter((count) => count > 0);

  // ── Build the snapshot ────────────────────────────────────────────────
  const baseline: RunnerBaseline = {
    generatedAt: new Date().toISOString(),
    schemaVersion: handle.getSchemaVersion(),
    filters: { since: since ?? undefined },
    summary: {
      totalRows: turns.length,
      distinctSessions: sessionIds.size,
      distinctRuns: runIds.size,
      mainAgentTurns: turns.filter((t) => t.is_subagent === 0).length,
      subagentTurns: turns.filter((t) => t.is_subagent === 1).length,
      dateRange: {
        from: turns[0]?.created_at ?? null,
        to: turns[turns.length - 1]?.created_at ?? null,
      },
    },
    tokens: {
      input: statFrom(pickNum('input_tokens')),
      output: statFrom(pickNum('output_tokens')),
      cacheRead: statFrom(pickNum('cache_read_input_tokens')),
      cacheCreation: statFrom(pickNum('cache_creation_input_tokens')),
      thinking: statFrom(pickNum('thinking_tokens')),
    },
    context: {
      historyChars: statFrom(pickNum('history_chars')),
      systemPromptChars: statFrom(pickNum('system_prompt_chars')),
      toolsDefChars: statFrom(pickNum('tools_def_chars')),
      largestToolResultChars: statFrom(pickNum('largest_tool_result_chars')),
    },
    compaction: {
      triggerRate: turns.filter((t) => t.compaction_triggered === 1).length / turns.length,
      summarizerRate: turns.filter((t) => t.summarizer_ran === 1).length / turns.length,
      paginateCount: statFrom(turns.map((t) => t.paginate_count)),
    },
    tools: {
      totalCalls: totalToolCalls,
      truncationRate,
      top20ByCount: topToolsRows,
      phaseDistribution: phaseRows,
    },
    turnsPerSession: {
      stat: statFrom(turnCounts),
      histogram: turnsHistogram(turnCounts),
    },
    estimatedCostUsd: {
      totalAllTime: pickNum('estimated_cost_usd').reduce((a, b) => a + b, 0),
      perTurn: statFrom(pickNum('estimated_cost_usd')),
    },
  };

  // ── Console summary ───────────────────────────────────────────────────
  console.log(`\n[runner-baseline] summary`);
  console.log(
    `  rows=${baseline.summary.totalRows}  sessions=${baseline.summary.distinctSessions}  runs=${baseline.summary.distinctRuns}  main=${baseline.summary.mainAgentTurns}  subagent=${baseline.summary.subagentTurns}`,
  );
  console.log(`  date range: ${baseline.summary.dateRange.from} → ${baseline.summary.dateRange.to}`);

  console.log(`\n[runner-baseline] tokens (per turn)`);
  logStat('input_tokens', baseline.tokens.input);
  logStat('output_tokens', baseline.tokens.output);
  logStat('cache_read', baseline.tokens.cacheRead);
  logStat('cache_creation', baseline.tokens.cacheCreation);
  logStat('thinking_tokens', baseline.tokens.thinking);

  console.log(`\n[runner-baseline] context size (per turn, chars)`);
  logStat('history_chars', baseline.context.historyChars);
  logStat('system_prompt_chars', baseline.context.systemPromptChars);
  logStat('tools_def_chars', baseline.context.toolsDefChars);
  logStat('largest_tool_result', baseline.context.largestToolResultChars);

  console.log(`\n[runner-baseline] compaction`);
  console.log(`  trigger rate: ${fmt(baseline.compaction.triggerRate * 100, 2)}%`);
  console.log(`  summarizer rate: ${fmt(baseline.compaction.summarizerRate * 100, 2)}%`);
  logStat('paginate_count', baseline.compaction.paginateCount);

  console.log(`\n[runner-baseline] tools`);
  console.log(
    `  total calls: ${baseline.tools.totalCalls}  truncation rate: ${fmt(baseline.tools.truncationRate * 100, 2)}%`,
  );
  if (baseline.tools.top20ByCount.length > 0) {
    console.log(`  top 20 by count:`);
    for (const t of baseline.tools.top20ByCount) {
      console.log(
        `    ${t.tool_name.padEnd(28)} calls=${String(t.calls).padStart(6)} avg_out=${String(t.avg_output_chars).padStart(7)} p95_out=${String(t.p95_output_chars).padStart(7)} trunc=${fmt(t.truncated_rate * 100, 1)}%`,
      );
    }
  }
  if (baseline.tools.phaseDistribution.length > 0) {
    console.log(`  phase distribution:`);
    for (const p of baseline.tools.phaseDistribution) {
      console.log(
        `    ${(p.phase ?? '(null)').padEnd(12)} ${String(p.count).padStart(6)}  ${fmt(p.share * 100, 1)}%`,
      );
    }
  }

  console.log(`\n[runner-baseline] turns per session`);
  logStat('turns', baseline.turnsPerSession.stat);
  console.log(`  histogram:`);
  for (const h of baseline.turnsPerSession.histogram) {
    console.log(`    ${h.bucket.padEnd(8)} ${String(h.count).padStart(6)}`);
  }

  console.log(`\n[runner-baseline] cost`);
  console.log(`  estimated USD total: $${fmt(baseline.estimatedCostUsd.totalAllTime, 4)}`);
  logStat('cost per turn', baseline.estimatedCostUsd.perTurn);

  // ── Persist ───────────────────────────────────────────────────────────
  const repoRoot = resolve(__dirname, '..', '..');
  const outDir = join(repoRoot, 'bench', 'results');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const outPath = values.output ?? join(outDir, `runner-baseline-${day}.json`);
  writeFileSync(outPath, JSON.stringify(baseline, null, 2));
  console.log(`\n[runner-baseline] written to ${outPath}`);

  handle.close();
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
