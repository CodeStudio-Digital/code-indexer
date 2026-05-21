/**
 * Wire #6 (Nível 4) — Counterfactual calibration analysis (offline).
 *
 * Reads `counterfactual_logs` and computes, per pipeline × shadow_variant:
 *
 *   - Total rows in window
 *   - Rows with observed outcome (`true_outcome_json` populated)
 *   - **Precision@K** — how often did the variant's top-K candidate set
 *     include the true outcome?
 *   - **Production baseline** — same metric, computed on the production
 *     choice (so we know whether a variant beats production or not)
 *   - **Lift** — `variant_precision - production_precision`. Positive
 *     means the variant outperforms production; negative means worse.
 *
 * This is a read-only batch job. It NEVER mutates the DB (no UPDATEs to
 * pipeline_provider_bindings, no writes to anything). Suggestions emerge
 * as a JSON report to stdout (or `--out <file>`). Operators read the
 * report, decide which weight adjustments to apply, then update bindings
 * via the admin panel.
 *
 * Run:
 *   pnpm tsx scripts/calibrate-counterfactuals.ts
 *   pnpm tsx scripts/calibrate-counterfactuals.ts --since 2026-01-01
 *   pnpm tsx scripts/calibrate-counterfactuals.ts --pipeline tool_selection
 *   pnpm tsx scripts/calibrate-counterfactuals.ts --out report.json
 *
 * Exit codes:
 *   0  — analysis ran (may or may not have actionable findings)
 *   1  — fatal error (DB unreachable, schema missing, …)
 *   2  — insufficient data (fewer than `--min-rows` rows with outcomes;
 *        the report is still written, but the operator should not act
 *        on weight changes from this run)
 */
import { writeFileSync } from 'node:fs';
import { loadConfig } from '@mcp/shared/utils/config.js';
import { CodeIndexDB } from '@mcp/store/db.js';
import {
  CounterfactualLogStore,
  type CounterfactualLogRow,
} from '@mcp/store/counterfactual-log-store.js';

interface CliArgs {
  since?: string;
  pipeline?: string;
  minRows: number;
  out?: string;
}

function parseArgs(argv: ReadonlyArray<string>): CliArgs {
  const out: CliArgs = { minRows: 30 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--since')        out.since = argv[++i];
    else if (a === '--pipeline') out.pipeline = argv[++i];
    else if (a === '--min-rows') out.minRows = Number(argv[++i]) || 30;
    else if (a === '--out')      out.out = argv[++i];
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  return out;
}

function printHelp(): void {
  process.stdout.write(
    [
      'calibrate-counterfactuals — offline analysis of shadow-traffic data',
      '',
      'Options:',
      '  --since YYYY-MM-DD   Only consider rows created on/after this date',
      '  --pipeline <name>    Only analyze a specific pipeline (e.g. tool_selection)',
      '  --min-rows <n>       Refuse to emit lift suggestions below this row count (default 30)',
      '  --out <file>         Write the JSON report to a file instead of stdout',
      '  -h, --help           Show this help',
      '',
    ].join('\n'),
  );
}

interface PerVariantReport {
  pipeline_name: string;
  shadow_variant: string;
  total_rows: number;
  rows_with_outcome: number;
  variant_precision: number | null;
  production_precision: number | null;
  lift: number | null;
  recommendation: 'insufficient_data' | 'keep_production' | 'consider_variant' | 'no_signal';
  evidence: string;
}

interface CalibrationReport {
  generated_at: string;
  args: CliArgs;
  totals: {
    total_rows: number;
    rows_with_outcome: number;
    pending_outcome: number;
    pipelines_observed: number;
    variants_observed: number;
  };
  per_variant: PerVariantReport[];
  notes: string[];
}

function safeJson<T>(text: string | null): T | null {
  if (!text) return null;
  try { return JSON.parse(text) as T; } catch { return null; }
}

/**
 * Compute precision@K: how often does the candidate set include AT LEAST
 * ONE element of the observed outcome set?
 *
 * Both sides may be sets (tool names, role names, …) or scalars (one role
 * spawned). We coerce both to Sets and check non-empty intersection.
 */
function precisionAtK(
  candidatesPerRow: ReadonlyArray<ReadonlySet<string>>,
  outcomesPerRow: ReadonlyArray<ReadonlySet<string>>,
): number | null {
  if (candidatesPerRow.length === 0) return null;
  let hits = 0;
  for (let i = 0; i < candidatesPerRow.length; i++) {
    const cands = candidatesPerRow[i];
    const outs = outcomesPerRow[i];
    if (!cands || !outs || outs.size === 0) continue;
    for (const o of outs) {
      if (cands.has(o)) { hits++; break; }
    }
  }
  return hits / candidatesPerRow.length;
}

/**
 * Extract a `Set<string>` from a parsed JSON blob, regardless of shape.
 * The shadow / production payloads vary by pipeline:
 *
 *   - tool_selection: `{ tools: ['Read','Edit',…] }`
 *   - role_pipeline:  `{ recommendations: [{ role: 'frontend' }, …] }`
 *   - kanban:         `[{ id, position }, …]`  (we extract names)
 *
 * Whatever we can't recognize → empty set (no precision contribution).
 */
function coerceSet(json: unknown): Set<string> {
  if (json == null) return new Set();
  if (Array.isArray(json)) {
    const out = new Set<string>();
    for (const v of json) {
      if (typeof v === 'string') out.add(v);
      else if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        if (typeof o.role === 'string')       out.add(o.role);
        else if (typeof o.name === 'string')  out.add(o.name);
        else if (typeof o.id !== 'undefined') out.add(String(o.id));
      }
    }
    return out;
  }
  if (typeof json === 'object') {
    const o = json as Record<string, unknown>;
    if (Array.isArray(o.tools))          return coerceSet(o.tools);
    if (Array.isArray(o.recommendations))return coerceSet(o.recommendations);
    if (Array.isArray(o.cards))          return coerceSet(o.cards);
    if (typeof o.role === 'string')      return new Set([o.role]);
    if (typeof o.tool === 'string')      return new Set([o.tool]);
    return new Set();
  }
  if (typeof json === 'string') return new Set([json]);
  return new Set();
}

function recommendationFor(lift: number, rowsWithOutcome: number, minRows: number): PerVariantReport['recommendation'] {
  if (rowsWithOutcome < minRows) return 'insufficient_data';
  if (Math.abs(lift) < 0.02) return 'no_signal';
  return lift > 0 ? 'consider_variant' : 'keep_production';
}

function analyzeGroup(
  pipelineName: string,
  shadowVariant: string,
  rows: ReadonlyArray<CounterfactualLogRow>,
  minRows: number,
): PerVariantReport {
  const rowsWithOutcome = rows.filter((r) => r.true_outcome_json != null);

  const variantCands: Set<string>[] = [];
  const prodCands: Set<string>[] = [];
  const outcomes: Set<string>[] = [];
  for (const r of rowsWithOutcome) {
    variantCands.push(coerceSet(safeJson(r.shadow_prediction_json)));
    prodCands.push(coerceSet(safeJson(r.production_choice_json)));
    outcomes.push(coerceSet(safeJson(r.true_outcome_json)));
  }

  const variantPrecision = precisionAtK(variantCands, outcomes);
  const productionPrecision = precisionAtK(prodCands, outcomes);
  const lift =
    variantPrecision != null && productionPrecision != null
      ? variantPrecision - productionPrecision
      : null;

  let evidence: string;
  if (rowsWithOutcome.length === 0) {
    evidence = 'No rows with observed outcomes yet — wait for the feedback collector to backfill more rows.';
  } else if (rowsWithOutcome.length < minRows) {
    evidence = `Only ${rowsWithOutcome.length} rows with outcomes (need ≥${minRows} for reliable lift estimate).`;
  } else if (lift == null) {
    evidence = 'Precision could not be computed (shadow_prediction or production_choice payload not recognised by the coercer).';
  } else if (Math.abs(lift) < 0.02) {
    evidence = `Variant precision ${(variantPrecision! * 100).toFixed(1)}% vs production ${(productionPrecision! * 100).toFixed(1)}% — within noise floor (|lift| < 2%).`;
  } else if (lift > 0) {
    evidence = `Variant precision ${(variantPrecision! * 100).toFixed(1)}% beats production ${(productionPrecision! * 100).toFixed(1)}% by ${(lift * 100).toFixed(1)} points. Worth A/B testing the underlying config.`;
  } else {
    evidence = `Variant precision ${(variantPrecision! * 100).toFixed(1)}% is BELOW production ${(productionPrecision! * 100).toFixed(1)}% by ${(Math.abs(lift) * 100).toFixed(1)} points. Keep production weights.`;
  }

  return {
    pipeline_name: pipelineName,
    shadow_variant: shadowVariant,
    total_rows: rows.length,
    rows_with_outcome: rowsWithOutcome.length,
    variant_precision: variantPrecision,
    production_precision: productionPrecision,
    lift,
    recommendation: lift == null
      ? (rowsWithOutcome.length < minRows ? 'insufficient_data' : 'no_signal')
      : recommendationFor(lift, rowsWithOutcome.length, minRows),
    evidence,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    process.stderr.write(`fatal: cannot load config (${e instanceof Error ? e.message : String(e)})\n`);
    process.exit(1);
  }
  let db;
  try {
    db = new CodeIndexDB(cfg.dbPath);
  } catch (e) {
    process.stderr.write(`fatal: cannot open DB at ${cfg.dbPath} (${e instanceof Error ? e.message : String(e)})\n`);
    process.exit(1);
  }
  const store = new CounterfactualLogStore(db.raw());

  // Pull rows once; group in memory. Counterfactual_logs is small enough
  // that we can afford to scan it.
  let rows: CounterfactualLogRow[];
  try {
    rows = store.list({
      pipelineName: args.pipeline,
      since: args.since,
      limit: 100_000, // realistic upper bound; 5% shadow rate ≈ 100k rows = months of data
    });
  } catch (e) {
    process.stderr.write(`fatal: failed to list counterfactual_logs (${e instanceof Error ? e.message : String(e)})\n`);
    db.close();
    process.exit(1);
  }

  // Group by (pipeline_name, shadow_variant).
  const groups = new Map<string, CounterfactualLogRow[]>();
  for (const r of rows) {
    const key = `${r.pipeline_name}::${r.shadow_variant}`;
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }

  const perVariant: PerVariantReport[] = [];
  for (const [key, group] of groups) {
    const [pipelineName, shadowVariant] = key.split('::');
    perVariant.push(analyzeGroup(pipelineName, shadowVariant, group, args.minRows));
  }
  perVariant.sort((a, b) => {
    if (a.pipeline_name !== b.pipeline_name) return a.pipeline_name.localeCompare(b.pipeline_name);
    return a.shadow_variant.localeCompare(b.shadow_variant);
  });

  const withOutcomeTotal = rows.filter((r) => r.true_outcome_json != null).length;
  const pipelines = new Set(rows.map((r) => r.pipeline_name));
  const variants = new Set(rows.map((r) => `${r.pipeline_name}::${r.shadow_variant}`));

  const notes: string[] = [];
  if (rows.length === 0) {
    notes.push('No counterfactual_logs rows found in the requested window. Ensure shadow traffic is enabled and the feedback collector has had time to backfill outcomes.');
  } else if (withOutcomeTotal < args.minRows) {
    notes.push(`Only ${withOutcomeTotal} of ${rows.length} rows have observed outcomes — below the --min-rows threshold (${args.minRows}). Treat all lift estimates below as preliminary.`);
  }
  const consider = perVariant.filter((p) => p.recommendation === 'consider_variant');
  if (consider.length > 0) {
    notes.push(`${consider.length} variant(s) show positive lift above noise floor. Review the per_variant section for specifics, then A/B test the corresponding weight/config change via the admin panel before promoting.`);
  }

  const report: CalibrationReport = {
    generated_at: new Date().toISOString(),
    args,
    totals: {
      total_rows: rows.length,
      rows_with_outcome: withOutcomeTotal,
      pending_outcome: rows.length - withOutcomeTotal,
      pipelines_observed: pipelines.size,
      variants_observed: variants.size,
    },
    per_variant: perVariant,
    notes,
  };

  const json = JSON.stringify(report, null, 2);
  if (args.out) {
    writeFileSync(args.out, json + '\n', 'utf8');
    process.stderr.write(`wrote ${args.out}\n`);
  } else {
    process.stdout.write(json + '\n');
  }
  db.close();

  if (withOutcomeTotal < args.minRows && rows.length > 0) {
    process.exit(2);
  }
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
