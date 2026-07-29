import type { FsSessionStore } from './fs-session-store.js';
import {
  listFilesystemTurnTelemetry,
  sumTelemetry,
  telemetryTools,
} from './telemetry-dashboard.js';

interface Aggregate {
  turns: number;
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number;
}

export async function getFilesystemGlobalTelemetrySummary(
  store: FsSessionStore,
  options: {
    limit?: number;
    project_id?: number | null;
    since?: string | null;
  } = {},
) {
  await store.ensureCatalog();
  const since = options.since ? Date.parse(options.since) : Number.NaN;
  const entries = store.catalog.list().filter((entry) =>
    options.project_id == null ||
    entry.session.owner_project_id === options.project_id ||
    entry.session.linked_projects.some(
      (project) => project.project_id === options.project_id));
  const sessions = await Promise.all(entries.map(async (entry) => {
    const [summary, allTurns] = await Promise.all([
      store.getMetricsSummary(entry.session.id),
      listFilesystemTurnTelemetry(store, entry.session.id),
    ]);
    return {
      entry,
      summary,
      turns: Number.isFinite(since)
        ? allTurns.filter((turn) => Date.parse(turn.created_at) >= since)
        : allTurns,
    };
  }));

  const providers = new Map<string, Aggregate>();
  const models = new Map<string, Aggregate>();
  const uncoveredModels = new Map<string, { turns: number; tokens: number }>();
  const tools = new Map<string, number>();
  let uncoveredTurns = 0;
  let uncoveredTokens = 0;
  let totalCost = 0;
  let compactions = 0;
  let paginations = 0;
  const bump = (target: Map<string, Aggregate>, key: string, input: number,
    output: number, cost: number) => {
    const value = target.get(key) ??
      { turns: 0, input_tokens: 0, output_tokens: 0, estimated_cost_usd: 0 };
    value.turns += 1;
    value.input_tokens += input;
    value.output_tokens += output;
    value.estimated_cost_usd += cost;
    target.set(key, value);
  };
  for (const session of sessions) {
    for (const turn of session.turns) {
      const input = turn.input_tokens ?? 0;
      const output = turn.output_tokens ?? 0;
      const cost = turn.estimated_cost_usd ?? 0;
      totalCost += cost;
      compactions += turn.compaction_triggered;
      paginations += turn.paginate_count;
      if (turn.provider) bump(providers, turn.provider, input, output, cost);
      if (turn.model) bump(models, turn.model, input, output, cost);
      for (const name of telemetryTools(turn.tools_called)) {
        tools.set(name, (tools.get(name) ?? 0) + 1);
      }
      if (turn.estimated_cost_usd == null &&
          (turn.input_tokens != null || turn.output_tokens != null)) {
        const tokens = input + output;
        uncoveredTurns += 1;
        uncoveredTokens += tokens;
        const key = turn.model ?? '(unknown)';
        const value = uncoveredModels.get(key) ?? { turns: 0, tokens: 0 };
        value.turns += 1;
        value.tokens += tokens;
        uncoveredModels.set(key, value);
      }
    }
  }

  const windowed = Number.isFinite(since);
  const metric = (
    key: 'input' | 'output' | 'cache_read',
    detailed: 'input_tokens' | 'output_tokens' | 'cache_read_input_tokens',
  ) => sessions.reduce((total, session) =>
    total + (windowed ? sumTelemetry(session.turns, detailed)
      : session.summary.tokens[key]), 0);
  const totalInput = metric('input', 'input_tokens');
  const totalOutput = metric('output', 'output_tokens');
  const totalCacheRead = metric('cache_read', 'cache_read_input_tokens');
  const turnCount = sessions.reduce((total, session) =>
    total + (windowed ? session.turns.length : session.summary.turns), 0);
  const topSessions = sessions.map(({ entry, summary, turns }) => {
    const input = windowed ? sumTelemetry(turns, 'input_tokens') : summary.tokens.input;
    const output = windowed ? sumTelemetry(turns, 'output_tokens') : summary.tokens.output;
    const cache = windowed
      ? sumTelemetry(turns, 'cache_read_input_tokens')
      : summary.tokens.cache_read;
    return {
      session_id: entry.session.id,
      title: entry.session.title,
      provider: entry.session.provider,
      model: entry.session.model,
      turn_count: windowed ? turns.length : summary.turns,
      total_input_tokens: input,
      total_output_tokens: output,
      cache_hit_ratio: input > 0 ? cache / input : null,
      last_turn_at: turns.at(-1)?.created_at ?? null,
      estimated_cost_usd: sumTelemetry(turns, 'estimated_cost_usd'),
    };
  }).filter((item) => item.turn_count > 0)
    .sort((a, b) => (b.total_input_tokens + b.total_output_tokens) -
      (a.total_input_tokens + a.total_output_tokens))
    .slice(0, Math.max(1, Math.min(500, options.limit ?? 50)));

  return {
    overall: {
      session_count: sessions.filter((item) =>
        windowed ? item.turns.length > 0 : item.summary.turns > 0).length,
      turn_count: turnCount,
      total_input_tokens: totalInput,
      total_output_tokens: totalOutput,
      total_cache_read_tokens: totalCacheRead,
      cache_hit_ratio: totalInput > 0 ? totalCacheRead / totalInput : null,
      compaction_turns: compactions,
      paginate_total: paginations,
      total_estimated_cost_usd: totalCost,
      truncation_rate: null,
    },
    coverage: {
      uncovered_turns: uncoveredTurns,
      uncovered_tokens: uncoveredTokens,
      total_turns: turnCount,
      uncovered_models: [...uncoveredModels].map(([model, value]) =>
        ({ model, ...value })).sort((a, b) => b.tokens - a.tokens).slice(0, 10),
    },
    by_provider: [...providers].map(([provider, value]) =>
      ({ provider, ...value })).sort((a, b) => b.input_tokens - a.input_tokens),
    by_model: [...models].map(([model, value]) =>
      ({ model, ...value })).sort((a, b) => b.input_tokens - a.input_tokens),
    skills_modes: [],
    top_tools: [...tools].map(([name, calls]) => ({
      name, calls, total_output_chars: 0, avg_duration_ms: 0,
      truncated_count: 0, errors: 0, refused: 0, propagated_failures: 0,
      reused: 0, shadow_candidates: 0,
    })).sort((a, b) => b.calls - a.calls).slice(0, 20),
    guard_rollout: [],
    phase_breakdown: [],
    top_sessions: topSessions,
  };
}

/**
 * Legacy cost backfill mutated SQL rows in place. Filesystem metrics are
 * immutable, so the stable endpoint reports coverage without rewriting them.
 */
export async function inspectFilesystemCostCoverage(store: FsSessionStore) {
  await store.ensureCatalog();
  const rows = (await Promise.all(store.catalog.list().map((entry) =>
    listFilesystemTurnTelemetry(store, entry.session.id)))).flat();
  const priced = rows.filter((row) => row.estimated_cost_usd != null).length;
  return {
    scanned: rows.length,
    updated: 0,
    nowPriced: priced,
    stillUnpriced: rows.length - priced,
    byModel: [],
    immutable: true,
  };
}
