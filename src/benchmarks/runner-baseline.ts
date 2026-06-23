/**
 * Runner baseline — aggregates existing `coder_turn_telemetry` + `coder_tool_calls`
 * rows into a snapshot we can diff against after any agent change.
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
 *   - tool-call distribution + truncation rate + phase breakdown
 *   - estimated_cost_usd
 *
 * Re-run this AFTER any agent change and diff vs the baseline JSON. Any
 * regression listed in the plan's "Critérios de revert" → flag OFF.
 */
import { parseArgs } from 'node:util';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '@mcp/shared/utils/config.js';
import { CodeIndexDB } from '@mcp/store/db.js';

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
  const db = handle.raw();
  const since = values.since ?? null;
  const sinceClause = since ? `WHERE created_at >= '${since.replace(/'/g, "''")}'` : '';
  console.log(`[runner-baseline] since: ${since ?? 'all-time'}`);

  // Detect missing tables: runner may have never run on this DB.
  const tableExists = (name: string): boolean => {
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
      .get(name) as { name?: string } | undefined;
    return !!row?.name;
  };
  if (!tableExists('coder_turn_telemetry')) {
    console.error(
      '[runner-baseline] coder_turn_telemetry table missing — agent has not produced telemetry on this DB yet.',
    );
    process.exit(1);
  }

  // ── Pull turn rows ────────────────────────────────────────────────────
  type TurnRow = {
    session_id: number | null;
    run_id: string;
    turn: number;
    is_subagent: number;
    input_tokens: number | null;
    output_tokens: number | null;
    cache_read_input_tokens: number | null;
    cache_creation_input_tokens: number | null;
    thinking_tokens: number | null;
    history_chars: number | null;
    system_prompt_chars: number | null;
    tools_def_chars: number | null;
    largest_tool_result_chars: number | null;
    compaction_triggered: number;
    summarizer_ran: number;
    paginate_count: number;
    estimated_cost_usd: number | null;
    created_at: string;
  };

  const turns = db
    .prepare(`SELECT * FROM coder_turn_telemetry ${sinceClause} ORDER BY created_at ASC`)
    .all() as TurnRow[];

  if (turns.length === 0) {
    console.error(
      `[runner-baseline] no rows in coder_turn_telemetry${since ? ` since ${since}` : ''} — nothing to baseline.`,
    );
    process.exit(1);
  }

  const sessionIds = new Set<number>();
  const runIds = new Set<string>();
  for (const t of turns) {
    if (t.session_id != null) sessionIds.add(t.session_id);
    runIds.add(t.run_id);
  }

  // Numeric vectors with NULLs filtered out — we measure where the field
  // was populated, not artificially deflate the mean with zeros.
  const pickNum = (key: keyof TurnRow): number[] =>
    turns
      .map((t) => t[key])
      .filter((v): v is number => typeof v === 'number');

  // ── Tools aggregates ──────────────────────────────────────────────────
  let topToolsRows: ToolRow[] = [];
  let phaseRows: PhaseRow[] = [];
  let totalToolCalls = 0;
  let truncationRate = 0;
  if (tableExists('coder_tool_calls')) {
    const sinceJoinClause = since
      ? `WHERE coder_tool_calls.created_at >= '${since.replace(/'/g, "''")}'`
      : '';
    const top = db
      .prepare(
        `SELECT tool_name,
                COUNT(*) AS calls,
                AVG(COALESCE(output_chars, 0)) AS avg_output_chars,
                SUM(CASE WHEN truncated = 1 THEN 1 ELSE 0 END) AS truncated_count,
                SUM(CASE WHEN truncated = 1 THEN 1 ELSE 0 END) * 1.0 / COUNT(*) AS truncated_rate
         FROM coder_tool_calls
         ${sinceJoinClause}
         GROUP BY tool_name
         ORDER BY calls DESC
         LIMIT 20`,
      )
      .all() as Array<{
      tool_name: string;
      calls: number;
      avg_output_chars: number;
      truncated_count: number;
      truncated_rate: number;
    }>;
    // p95 of output_chars per tool — separate query per tool to keep memory bounded
    const stmtP95 = db.prepare(
      `SELECT output_chars FROM coder_tool_calls WHERE tool_name = ? ${
        since ? `AND created_at >= '${since.replace(/'/g, "''")}'` : ''
      } AND output_chars IS NOT NULL ORDER BY output_chars`,
    );
    topToolsRows = top.map((r) => {
      const rows = stmtP95.all(r.tool_name) as Array<{ output_chars: number }>;
      const sortedVals = rows.map((x) => x.output_chars);
      return {
        tool_name: r.tool_name,
        calls: r.calls,
        avg_output_chars: Math.round(r.avg_output_chars),
        p95_output_chars: Math.round(quantile(sortedVals, 0.95)),
        truncated_rate: r.truncated_rate,
      };
    });

    const totalsRow = db
      .prepare(
        `SELECT COUNT(*) AS calls,
                SUM(CASE WHEN truncated = 1 THEN 1 ELSE 0 END) * 1.0 / COUNT(*) AS truncated_rate
         FROM coder_tool_calls ${sinceJoinClause}`,
      )
      .get() as { calls: number; truncated_rate: number };
    totalToolCalls = totalsRow.calls;
    truncationRate = totalsRow.truncated_rate ?? 0;

    const phaseTotalsRow = db
      .prepare(`SELECT COUNT(*) AS total FROM coder_tool_calls ${sinceJoinClause}`)
      .get() as { total: number };
    const totalPhase = phaseTotalsRow.total || 1;
    const phases = db
      .prepare(
        `SELECT phase, COUNT(*) AS count
         FROM coder_tool_calls
         ${sinceJoinClause}
         GROUP BY phase
         ORDER BY count DESC`,
      )
      .all() as Array<{ phase: string | null; count: number }>;
    phaseRows = phases.map((p) => ({ phase: p.phase, count: p.count, share: p.count / totalPhase }));
  } else {
    console.log('[runner-baseline] coder_tool_calls table missing — tool aggregates skipped.');
  }

  // ── Turns-per-session distribution ────────────────────────────────────
  const turnsPerSession = db
    .prepare(
      `SELECT session_id, COUNT(*) AS turns
       FROM coder_turn_telemetry
       ${sinceClause}
       GROUP BY session_id
       HAVING session_id IS NOT NULL`,
    )
    .all() as Array<{ session_id: number; turns: number }>;
  const turnCounts = turnsPerSession.map((r) => r.turns);

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
