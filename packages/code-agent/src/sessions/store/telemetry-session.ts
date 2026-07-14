import type { Database as DB } from 'better-sqlite3';
import { computeSavings, type SavingsBreakdown, type TurnForSavings } from './telemetry-savings.js';
import { resolvePricingWithSource } from '@mcp/code-agent/providers/pricing-cache.js';
import {
  GENUINE_ERROR_SQL,
  PROPAGATED_PARENT_FAILURE_SQL,
  REUSE_SQL,
  ROOT_REFUSAL_SQL,
  SHADOW_CANDIDATE_SQL,
} from './guard-outcome-sql.js';

function columnExists(db: DB, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .some((row) => row.name === column);
}

function tableExists(db: DB, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

export interface SessionTelemetrySummary {
  turn_count: number;
  subagent_turn_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  total_thinking_tokens: number;
  cache_hit_ratio: number | null;
  total_tool_calls: number;
  /** Peak prompt carried by any one provider call (main run or subagent). */
  peak_context_tokens: number;
  compaction_turns: number;
  summarizer_turns: number;
  compaction_attempts: number;
  llm_summaries: number;
  persisted_chapters: number;
  mechanical_fallbacks: number;
  checkpoint_failures: number;
  /** Migration 130 — lifetime durable-compaction counters (survive compaction). */
  compaction_count_auto: number;
  compaction_count_manual: number;
  /**
   * Migration 130 — lifetime message counts from `coder_messages`, INDEPENDENT
   * of the summary boundary (rows are hidden on compaction, never deleted), so
   * these never shrink. `messages_all` = every row (incl. tool results);
   * `messages_conversation` = user + assistant (role != 'tool'); `messages_user`
   * = user prompts only.
   */
  messages_all: number;
  messages_conversation: number;
  messages_user: number;
  paginate_total: number;
  largest_tool_result_chars: number | null;
  last_history_chars: number | null;
  last_turn_at: string | null;
  tools_breakdown: Array<{
    name: string;
    calls: number;
    total_output_chars: number;
    avg_duration_ms: number;
    truncated_count: number;
    errors: number;
    refused: number;
    propagated_failures: number;
    reused: number;
    shadow_candidates: number;
  }>;
  /** Migration 072 — total USD cost for this session (estimated). */
  estimated_cost_usd: number;
  /** Migration 072 — average system prompt size on assistant turns. */
  system_prompt_avg_chars: number | null;
  /** Migration 072 — average tools array size on assistant turns. */
  tools_def_avg_chars: number | null;
  /** Migration 072 — fraction of tool calls that hit a truncation cap. */
  truncation_rate: number | null;
  /** Migration 072 — token+cost breakdown per phase (Camada 2). */
  phase_breakdown: Array<{
    phase: string;
    tool_calls: number;
    total_output_chars: number;
    total_duration_ms: number;
  }>;
  /** Fase 3 — "Economia Real" per-technique savings (cache exact, shaping fwd, tiers estimate). */
  savings: SavingsBreakdown;
  /** Migration 213 — compact canonical JSON versus the Markdown/text actually delivered. */
  structured_output: {
    calls: number;
    structured_chars: number;
    delivered_chars: number;
    saved_chars: number;
    reduction_ratio: number | null;
  };
}

/**
 * Aggregate per-session telemetry for the metrics modal in the chat view.
 * Returns totals across every turn (including subagent turns) plus a few
 * derived ratios. All values may be null when the session has no telemetry
 * rows yet (e.g. fresh session before turn 1).
 */
export function getSessionTelemetrySummary(db: DB, sessionId: number): SessionTelemetrySummary {
  const totals = db
    .prepare(
      `SELECT
         COUNT(*)                                   AS turn_count,
         COALESCE(SUM(is_subagent), 0)              AS subagent_turn_count,
         COALESCE(SUM(input_tokens), 0)             AS total_input_tokens,
         COALESCE(SUM(output_tokens), 0)            AS total_output_tokens,
         COALESCE(SUM(cache_read_input_tokens), 0)  AS total_cache_read_tokens,
         COALESCE(SUM(cache_creation_input_tokens), 0) AS total_cache_creation_tokens,
         COALESCE(SUM(thinking_tokens), 0)          AS total_thinking_tokens,
         COALESCE(SUM(tool_count), 0)               AS total_tool_calls,
         COALESCE(MAX(input_tokens), 0)             AS peak_context_tokens,
         COALESCE(SUM(compaction_triggered), 0)     AS compaction_turns,
         COALESCE(SUM(summarizer_ran), 0)           AS summarizer_turns,
         COALESCE(SUM(paginate_count), 0)           AS paginate_total,
         MAX(largest_tool_result_chars)             AS largest_tool_result_chars,
         MAX(history_chars)                         AS last_history_chars,
         MAX(created_at)                            AS last_turn_at,
         COALESCE(SUM(estimated_cost_usd), 0)       AS estimated_cost_usd,
         AVG(system_prompt_chars)                   AS system_prompt_avg_chars,
         AVG(tools_def_chars)                       AS tools_def_avg_chars
       FROM coder_turn_telemetry
       WHERE session_id = ?`,
    )
    .get(sessionId) as Omit<
      SessionTelemetrySummary,
      | 'tools_breakdown'
      | 'phase_breakdown'
      | 'cache_hit_ratio'
      | 'truncation_rate'
      | 'compaction_count_auto'
      | 'compaction_count_manual'
      | 'messages_all'
      | 'messages_conversation'
      | 'messages_user'
      | 'structured_output'
      | 'compaction_attempts'
      | 'llm_summaries'
      | 'persisted_chapters'
      | 'mechanical_fallbacks'
      | 'checkpoint_failures'
    >;

  const compactionAudit = tableExists(db, 'coder_compaction_attempts')
    ? db.prepare(`
        SELECT COUNT(*) AS compaction_attempts,
          COALESCE(SUM(CASE
            WHEN summarizer_ran = 1 AND strategy = 'summarizer'
              AND status IN ('summarized', 'checkpoint_failed') THEN 1 ELSE 0 END), 0) AS llm_summaries,
          COALESCE(SUM(CASE WHEN status = 'deterministic_fallback' THEN 1 ELSE 0 END), 0) AS mechanical_fallbacks,
          COALESCE(SUM(CASE WHEN status = 'checkpoint_failed' THEN 1 ELSE 0 END), 0) AS checkpoint_failures,
          COALESCE(SUM(summarizer_ran), 0) AS summarizer_turns
        FROM coder_compaction_attempts WHERE session_id = ?
      `).get(sessionId) as {
        compaction_attempts: number;
        llm_summaries: number;
        mechanical_fallbacks: number;
        checkpoint_failures: number;
        summarizer_turns: number;
      }
    : {
        compaction_attempts: totals.compaction_turns,
        llm_summaries: totals.summarizer_turns,
        mechanical_fallbacks: 0,
        checkpoint_failures: 0,
        summarizer_turns: totals.summarizer_turns,
      };
  const persistedChapters = tableExists(db, 'coder_session_chapters')
    ? (db.prepare(`
        SELECT COUNT(*) AS count FROM coder_session_chapters WHERE session_id = ?
      `).get(sessionId) as { count: number }).count
    : 0;

  // Migration 130: lifetime message counts straight from `coder_messages`. NOT
  // boundary-filtered on purpose — the panel's whole point is a count that does
  // NOT shrink when the window is summarized. `role != 'tool'` matches the
  // "renderable" (user+assistant) semantics used by loadTail/loadBefore.
  const msgCounts = db
    .prepare(
      `SELECT
         COUNT(*)                                                   AS messages_all,
         COALESCE(SUM(CASE WHEN role != 'tool' THEN 1 ELSE 0 END), 0) AS messages_conversation,
         COALESCE(SUM(CASE WHEN role  = 'user' THEN 1 ELSE 0 END), 0) AS messages_user
       FROM coder_messages
       WHERE session_id = ?`,
    )
    .get(sessionId) as { messages_all: number; messages_conversation: number; messages_user: number };

  // Migration 130: durable-compaction counters live on the session row (bumped
  // by setCompactionBoundary for both auto + manual). COALESCE guards a brand
  // new session whose row predates the column on an un-migrated dev DB.
  const compactionCounts = db
    .prepare(
      `SELECT COALESCE(compaction_count_auto, 0)   AS compaction_count_auto,
              COALESCE(compaction_count_manual, 0) AS compaction_count_manual
       FROM coder_sessions
       WHERE id = ?`,
    )
    .get(sessionId) as { compaction_count_auto: number; compaction_count_manual: number } | undefined;

  // Migration 072: tools breakdown JOINs coder_tool_calls for richer metrics
  // (output_chars, duration, truncation). Falls back to the legacy
  // tools_called_json count-only path for sessions older than migration 072.
  const toolStats = db
    .prepare(
      `SELECT
          tc.tool_name                              AS name,
          COUNT(*)                                  AS calls,
          COALESCE(SUM(tc.output_chars), 0)         AS total_output_chars,
          COALESCE(AVG(tc.duration_ms), 0)          AS avg_duration_ms,
          COALESCE(SUM(tc.truncated), 0)            AS truncated_count,
          COALESCE(SUM(CASE WHEN ${GENUINE_ERROR_SQL} THEN 1 ELSE 0 END), 0) AS errors,
          COALESCE(SUM(CASE WHEN ${ROOT_REFUSAL_SQL} THEN 1 ELSE 0 END), 0) AS refused,
          COALESCE(SUM(CASE WHEN ${PROPAGATED_PARENT_FAILURE_SQL} THEN 1 ELSE 0 END), 0) AS propagated_failures,
          COALESCE(SUM(CASE WHEN ${REUSE_SQL} THEN 1 ELSE 0 END), 0) AS reused,
          COALESCE(SUM(CASE WHEN ${SHADOW_CANDIDATE_SQL} THEN 1 ELSE 0 END), 0) AS shadow_candidates
       FROM coder_tool_calls tc
       JOIN coder_messages m ON m.id = tc.message_id
       WHERE m.session_id = ?
       GROUP BY tc.tool_name
       ORDER BY total_output_chars DESC, calls DESC`,
    )
    .all(sessionId) as Array<{
      name: string;
      calls: number;
      total_output_chars: number;
      avg_duration_ms: number;
      truncated_count: number;
      errors: number;
      refused: number;
      propagated_failures: number;
      reused: number;
      shadow_candidates: number;
    }>;

  let tools_breakdown: SessionTelemetrySummary['tools_breakdown'];
  if (toolStats.length > 0) {
    tools_breakdown = toolStats.map((r) => ({ ...r, avg_duration_ms: Math.round(r.avg_duration_ms) }));
  } else {
    // Legacy fallback — only call counts.
    const rows = db
      .prepare(`SELECT tools_called_json FROM coder_turn_telemetry WHERE session_id = ?`)
      .all(sessionId) as Array<{ tools_called_json: string | null }>;
    const breakdown = new Map<string, number>();
    for (const r of rows) {
      if (!r.tools_called_json) continue;
      try {
        const names = JSON.parse(r.tools_called_json) as unknown;
        if (Array.isArray(names)) {
          for (const n of names) {
            if (typeof n === 'string') breakdown.set(n, (breakdown.get(n) ?? 0) + 1);
          }
        }
      } catch { /* malformed row */ }
    }
    tools_breakdown = [...breakdown.entries()]
      .map(([name, calls]) => ({
        name, calls, total_output_chars: 0, avg_duration_ms: 0, truncated_count: 0,
        errors: 0, refused: 0, propagated_failures: 0, reused: 0, shadow_candidates: 0,
      }))
      .sort((a, b) => b.calls - a.calls);
  }

  // Migration 072: phase breakdown. NULL phase rows bucket as 'unknown' until
  // PhaseRouter (Camada 2) populates it. Useful day-1 because it makes the
  // empty-state visible (dashboard renders the panel and says
  // "phase routing not active yet").
  const phaseRows = db
    .prepare(
      `SELECT
          COALESCE(tc.phase, 'unknown')             AS phase,
          COUNT(*)                                  AS tool_calls,
          COALESCE(SUM(tc.output_chars), 0)         AS total_output_chars,
          COALESCE(SUM(tc.duration_ms), 0)          AS total_duration_ms
       FROM coder_tool_calls tc
       JOIN coder_messages m ON m.id = tc.message_id
       WHERE m.session_id = ?
       GROUP BY phase
       ORDER BY tool_calls DESC`,
    )
    .all(sessionId) as SessionTelemetrySummary['phase_breakdown'];

  // Truncation rate across all tool calls (NULL when no rows).
  const truncRow = db
    .prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(truncated), 0) AS trunc
       FROM coder_tool_calls tc
       JOIN coder_messages m ON m.id = tc.message_id
       WHERE m.session_id = ?`,
    )
    .get(sessionId) as { total: number; trunc: number };
  const truncation_rate = truncRow.total > 0 ? truncRow.trunc / truncRow.total : null;

  const inputTotal = totals.total_input_tokens;
  const cacheRead = totals.total_cache_read_tokens;
  const cache_hit_ratio = inputTotal > 0 ? cacheRead / inputTotal : null;

  // "Economia Real" — per-turn rows for cache $ + tier estimate, and the
  // raw-vs-shaped tool-output SUM for shaping savings.
  // Some installations recorded migration 206 before
  // `eligible_tools_def_chars` was added to that migration's source. Migration
  // 209 repairs those files on restart; the read fallback keeps this endpoint
  // available even while such a database is still open in the old process.
  const eligibleToolsExpr = columnExists(db, 'coder_turn_telemetry', 'eligible_tools_def_chars')
    ? 'eligible_tools_def_chars'
    : 'NULL AS eligible_tools_def_chars';
  const turnRows = db
    .prepare(
      `SELECT provider, model,
              COALESCE(input_tokens, 0)            AS input_tokens,
              COALESCE(cache_read_input_tokens, 0) AS cache_read_input_tokens,
              tools_def_chars, ${eligibleToolsExpr}
       FROM coder_turn_telemetry WHERE session_id = ?`,
    )
    .all(sessionId) as TurnForSavings[];
  const shapingRow = db
    .prepare(
      `SELECT COALESCE(SUM(tc.output_chars), 0) AS raw,
              COALESCE(SUM(COALESCE(tc.output_chars_shaped, tc.output_chars)), 0) AS shaped
       FROM coder_tool_calls tc
       JOIN coder_messages m ON m.id = tc.message_id
       WHERE m.session_id = ? AND tc.parent_tool_use_id IS NULL`,
    )
    .get(sessionId) as { raw: number; shaped: number };
  const savings = computeSavings({
    turns: turnRows,
    rawToolChars: shapingRow.raw,
    shapedToolChars: shapingRow.shaped,
    resolvePricing: (p, m) => resolvePricingWithSource(p, m).pricing,
  });

  const structuredOutput = columnExists(db, 'coder_tool_calls', 'structured_output_chars')
    ? db.prepare(
      `SELECT COUNT(*) AS calls,
              COALESCE(SUM(tc.structured_output_chars), 0) AS structured_chars,
              COALESCE(SUM(COALESCE(tc.output_chars_shaped, tc.output_chars)), 0) AS delivered_chars
         FROM coder_tool_calls tc
         JOIN coder_messages m ON m.id = tc.message_id
        WHERE m.session_id = ?
          AND tc.parent_tool_use_id IS NULL
          AND tc.structured_output_chars IS NOT NULL`,
    ).get(sessionId) as { calls: number; structured_chars: number; delivered_chars: number }
    : { calls: 0, structured_chars: 0, delivered_chars: 0 };
  const savedChars = structuredOutput.structured_chars - structuredOutput.delivered_chars;
  const structured_output: SessionTelemetrySummary['structured_output'] = {
    ...structuredOutput,
    saved_chars: savedChars,
    reduction_ratio: structuredOutput.structured_chars > 0 ? savedChars / structuredOutput.structured_chars : null,
  };

  return {
    ...totals,
    compaction_turns: compactionAudit.compaction_attempts,
    summarizer_turns: compactionAudit.summarizer_turns,
    compaction_attempts: compactionAudit.compaction_attempts,
    llm_summaries: compactionAudit.llm_summaries,
    persisted_chapters: persistedChapters,
    mechanical_fallbacks: compactionAudit.mechanical_fallbacks,
    checkpoint_failures: compactionAudit.checkpoint_failures,
    messages_all: msgCounts.messages_all,
    messages_conversation: msgCounts.messages_conversation,
    messages_user: msgCounts.messages_user,
    compaction_count_auto: compactionCounts?.compaction_count_auto ?? 0,
    compaction_count_manual: compactionCounts?.compaction_count_manual ?? 0,
    cache_hit_ratio,
    tools_breakdown,
    phase_breakdown: phaseRows,
    truncation_rate,
    savings,
    structured_output,
  };
}
