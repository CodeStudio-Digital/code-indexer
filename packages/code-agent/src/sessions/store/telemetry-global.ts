import type { Database as DB } from 'better-sqlite3';

export interface GlobalTelemetrySummary {
  overall: {
    session_count: number;
    turn_count: number;
    total_input_tokens: number;
    total_output_tokens: number;
    total_cache_read_tokens: number;
    cache_hit_ratio: number | null;
    compaction_turns: number;
    paginate_total: number;
    /** Migration 072. */
    total_estimated_cost_usd: number;
    /** Migration 072. */
    truncation_rate: number | null;
  };
  by_provider: Array<{
    provider: string;
    turns: number;
    input_tokens: number;
    output_tokens: number;
    estimated_cost_usd: number;
  }>;
  by_model: Array<{
    model: string;
    turns: number;
    input_tokens: number;
    output_tokens: number;
    estimated_cost_usd: number;
  }>;
  skills_modes: Array<{ mode: string; sessions: number }>;
  /** Migration 072 — top tools globally by output_chars. */
  top_tools: Array<{
    name: string;
    calls: number;
    total_output_chars: number;
    avg_duration_ms: number;
    truncated_count: number;
  }>;
  /** Migration 072 — phase breakdown (Camada 2). */
  phase_breakdown: Array<{
    phase: string;
    tool_calls: number;
    total_output_chars: number;
    total_duration_ms: number;
  }>;
  top_sessions: Array<{
    session_id: number | null;
    title: string | null;
    provider: string | null;
    model: string | null;
    turn_count: number;
    total_input_tokens: number;
    total_output_tokens: number;
    cache_hit_ratio: number | null;
    last_turn_at: string | null;
    /** Migration 072. */
    estimated_cost_usd: number;
  }>;
}

/**
 * Global telemetry aggregates for the admin dashboard. One row per session,
 * plus an overall totals object. Limit caps the number of session summaries
 * returned (default 50, ordered by total tokens desc).
 */
export function getGlobalTelemetrySummary(
  db: DB,
  opts: { limit?: number; project_id?: number | null; since?: string | null } = {},
): GlobalTelemetrySummary {
  const limit = opts.limit ?? 50;
  // Build common WHERE clause for project + since filters. We index on
  // session.project_id and on telemetry.created_at, so a parameterized
  // string is fine — values are SQL-bound, not concatenated.
  const turnFilters: string[] = [];
  const turnParams: Array<string | number> = [];
  if (opts.project_id != null) {
    turnFilters.push(`t.session_id IN (SELECT id FROM coder_sessions WHERE project_id = ?)`);
    turnParams.push(opts.project_id);
  }
  if (opts.since) {
    turnFilters.push(`t.created_at >= ?`);
    turnParams.push(opts.since);
  }
  const turnWhere = turnFilters.length > 0 ? ' AND ' + turnFilters.join(' AND ') : '';

  const toolFilters: string[] = [];
  const toolParams: Array<string | number> = [];
  if (opts.project_id != null) {
    toolFilters.push(`m.session_id IN (SELECT id FROM coder_sessions WHERE project_id = ?)`);
    toolParams.push(opts.project_id);
  }
  if (opts.since) {
    toolFilters.push(`tc.created_at >= ?`);
    toolParams.push(opts.since);
  }
  const toolWhere = toolFilters.length > 0 ? 'WHERE ' + toolFilters.join(' AND ') : '';

  const overall = db
    .prepare(
      `SELECT
         COUNT(DISTINCT t.session_id)               AS session_count,
         COUNT(*)                                   AS turn_count,
         COALESCE(SUM(t.input_tokens), 0)           AS total_input_tokens,
         COALESCE(SUM(t.output_tokens), 0)          AS total_output_tokens,
         COALESCE(SUM(t.cache_read_input_tokens), 0) AS total_cache_read_tokens,
         COALESCE(SUM(t.compaction_triggered), 0)   AS compaction_turns,
         COALESCE(SUM(t.paginate_count), 0)         AS paginate_total,
         COALESCE(SUM(t.estimated_cost_usd), 0)     AS total_estimated_cost_usd
       FROM coder_turn_telemetry t
       WHERE 1=1${turnWhere}`,
    )
    .get(...turnParams) as Omit<GlobalTelemetrySummary['overall'], 'cache_hit_ratio' | 'truncation_rate'>;
  const cache_hit_ratio = overall.total_input_tokens > 0
    ? overall.total_cache_read_tokens / overall.total_input_tokens
    : null;

  const truncOverall = db
    .prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(tc.truncated), 0) AS trunc
       FROM coder_tool_calls tc
       JOIN coder_messages m ON m.id = tc.message_id
       ${toolWhere}`,
    )
    .get(...toolParams) as { total: number; trunc: number };
  const truncation_rate = truncOverall.total > 0 ? truncOverall.trunc / truncOverall.total : null;

  const by_provider = db
    .prepare(
      `SELECT t.provider AS provider, COUNT(*) AS turns,
              COALESCE(SUM(t.input_tokens), 0)         AS input_tokens,
              COALESCE(SUM(t.output_tokens), 0)        AS output_tokens,
              COALESCE(SUM(t.estimated_cost_usd), 0)   AS estimated_cost_usd
       FROM coder_turn_telemetry t
       WHERE t.provider IS NOT NULL${turnWhere}
       GROUP BY t.provider
       ORDER BY input_tokens DESC`,
    )
    .all(...turnParams) as GlobalTelemetrySummary['by_provider'];

  const by_model = db
    .prepare(
      `SELECT COALESCE(t.request_api_model, t.model) AS model, COUNT(*) AS turns,
              COALESCE(SUM(t.input_tokens), 0)         AS input_tokens,
              COALESCE(SUM(t.output_tokens), 0)        AS output_tokens,
              COALESCE(SUM(t.estimated_cost_usd), 0)   AS estimated_cost_usd
       FROM coder_turn_telemetry t
       WHERE COALESCE(t.request_api_model, t.model) IS NOT NULL${turnWhere}
       GROUP BY COALESCE(t.request_api_model, t.model)
       ORDER BY input_tokens DESC`,
    )
    .all(...turnParams) as GlobalTelemetrySummary['by_model'];

  // Skills mode adoption: count distinct sessions by the persisted skills_mode
  // meta. NULL meta (legacy rows) bucketed as 'unknown'.
  const skillsFilters: string[] = [`kind = 'system_prompt'`];
  const skillsParams: Array<string | number> = [];
  if (opts.project_id != null) {
    skillsFilters.push(`session_id IN (SELECT id FROM coder_sessions WHERE project_id = ?)`);
    skillsParams.push(opts.project_id);
  }
  if (opts.since) {
    skillsFilters.push(`created_at >= ?`);
    skillsParams.push(opts.since);
  }
  const skillsModes = db
    .prepare(
      `SELECT
          COALESCE(json_extract(meta_json, '$.skills_mode'), 'unknown') AS mode,
          COUNT(DISTINCT session_id)                                     AS sessions
       FROM coder_session_inputs
       WHERE ${skillsFilters.join(' AND ')}
       GROUP BY mode
       ORDER BY sessions DESC`,
    )
    .all(...skillsParams) as Array<{ mode: string; sessions: number }>;

  const top_tools = db
    .prepare(
      `SELECT
          tc.tool_name                              AS name,
          COUNT(*)                                  AS calls,
          COALESCE(SUM(tc.output_chars), 0)         AS total_output_chars,
          COALESCE(AVG(tc.duration_ms), 0)          AS avg_duration_ms,
          COALESCE(SUM(tc.truncated), 0)            AS truncated_count
       FROM coder_tool_calls tc
       JOIN coder_messages m ON m.id = tc.message_id
       ${toolWhere}
       GROUP BY tc.tool_name
       ORDER BY total_output_chars DESC, calls DESC
       LIMIT 25`,
    )
    .all(...toolParams) as GlobalTelemetrySummary['top_tools'];

  const phase_breakdown = db
    .prepare(
      `SELECT
          COALESCE(tc.phase, 'unknown')             AS phase,
          COUNT(*)                                  AS tool_calls,
          COALESCE(SUM(tc.output_chars), 0)         AS total_output_chars,
          COALESCE(SUM(tc.duration_ms), 0)          AS total_duration_ms
       FROM coder_tool_calls tc
       JOIN coder_messages m ON m.id = tc.message_id
       ${toolWhere}
       GROUP BY phase
       ORDER BY tool_calls DESC`,
    )
    .all(...toolParams) as GlobalTelemetrySummary['phase_breakdown'];

  const top_sessions_raw = db
    .prepare(
      `SELECT t.session_id, s.title, s.provider, s.model,
              COUNT(*) AS turn_count,
              COALESCE(SUM(t.input_tokens), 0)            AS total_input_tokens,
              COALESCE(SUM(t.output_tokens), 0)           AS total_output_tokens,
              COALESCE(SUM(t.cache_read_input_tokens), 0) AS total_cache_read,
              COALESCE(SUM(t.estimated_cost_usd), 0)      AS estimated_cost_usd,
              MAX(t.created_at)                           AS last_turn_at
       FROM coder_turn_telemetry t
       LEFT JOIN coder_sessions s ON s.id = t.session_id
       WHERE t.session_id IS NOT NULL${turnWhere}
       GROUP BY t.session_id, s.title, s.provider, s.model
       ORDER BY total_input_tokens DESC
       LIMIT ?`,
    )
    .all(...turnParams, limit) as Array<{
      session_id: number | null;
      title: string | null;
      provider: string | null;
      model: string | null;
      turn_count: number;
      total_input_tokens: number;
      total_output_tokens: number;
      total_cache_read: number;
      estimated_cost_usd: number;
      last_turn_at: string | null;
    }>;

  return {
    overall: { ...overall, cache_hit_ratio, truncation_rate },
    by_provider,
    by_model,
    skills_modes: skillsModes,
    top_tools: top_tools.map((r) => ({ ...r, avg_duration_ms: Math.round(r.avg_duration_ms) })),
    phase_breakdown,
    top_sessions: top_sessions_raw.map((r) => ({
      session_id: r.session_id,
      title: r.title,
      provider: r.provider,
      model: r.model,
      turn_count: r.turn_count,
      total_input_tokens: r.total_input_tokens,
      total_output_tokens: r.total_output_tokens,
      cache_hit_ratio: r.total_input_tokens > 0 ? r.total_cache_read / r.total_input_tokens : null,
      estimated_cost_usd: r.estimated_cost_usd,
      last_turn_at: r.last_turn_at,
    })),
  };
}
