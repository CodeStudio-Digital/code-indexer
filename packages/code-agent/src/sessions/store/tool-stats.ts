import type { Database as DB } from 'better-sqlite3';
import {
  GENUINE_ERROR_SQL,
  PROPAGATED_PARENT_FAILURE_SQL,
  REUSE_SQL,
  ROOT_REFUSAL_SQL,
  SHADOW_CANDIDATE_SQL,
} from './guard-outcome-sql.js';

export interface ToolCallStats {
  totalCalls: number;
  directCalls: number;
  nestedCalls: number;
  guardOutcomes: {
    genuineErrors: number;
    rootRefusals: number;
    propagatedParentFailures: number;
    reusedCalls: number;
    shadowCandidates: number;
  };
  /**
   * `errorCount` = genuine tool failures only; `refusedCount` = root-cause
   * refusals only. A direct code_exec row that merely propagates its nested
   * refusal is counted separately in `propagatedFailureCount`.
   */
  byName: Array<{
    name: string;
    count: number;
    errorCount: number;
    refusedCount: number;
    propagatedFailureCount: number;
    reuseCount: number;
    shadowCount: number;
    lastAt: string | null;
  }>;
  recent: Array<{
    id: number;
    name: string;
    argsPreview: string;
    isError: boolean;
    durationMs: number;
    createdAt: string;
    outcome: 'success' | 'genuine_error' | 'root_refusal' | 'propagated_parent_failure' | 'reuse' | 'shadow';
    guardAction: string | null;
    guardReason: string | null;
  }>;
  savings: {
    totalRawChars: number;
    totalShapedChars: number;
    totalSavedChars: number;
    totalSavedTokensEst: number;
    byTool: Array<{ name: string; rawChars: number; shapedChars: number; savedChars: number }>;
    semanticSavedChars: number;
    jsonCrushSavedChars: number;
    hardCapSavedChars: number;
    nestedRawChars: number;
    byTechnique: Array<{ kind: string; technique: string; calls: number; rawChars: number; shapedChars: number; savedChars: number }>;
  };
}

/**
 * Aggregate tool-call statistics for a session — used by the
 * `/api/coder/sessions/:id/tool-stats` diagnostic endpoint so the operator
 * can answer "what is this session actually doing?" in one click.
 *
 * Returns: totalCalls, byName (sorted desc), recent (last N), savings
 * (raw vs. shaped output sizes), with a 4-chars/token estimate.
 *
 * Heavy session optimisation: queries are capped server-side and use the
 * existing `idx_coder_messages_session` index. Empty results for a fresh
 * session return zeros (not null) so the UI doesn't need a separate
 * "no data" branch.
 */
export function getToolCallStats(db: DB, sessionId: number, recentLimit = 30): ToolCallStats {
  // A nested guard refusal produces two audit rows when it escapes code_exec:
  // the nested root-cause row and the direct parent code_exec result. Keep the
  // parent visible, but do not count it as a second refusal or genuine error.
  const byNameRows = db
    .prepare(
      `SELECT
          tc.tool_name                  AS name,
          COUNT(*)                      AS count,
          COALESCE(SUM(CASE WHEN ${GENUINE_ERROR_SQL} THEN 1 ELSE 0 END), 0) AS errorCount,
          COALESCE(SUM(CASE WHEN ${ROOT_REFUSAL_SQL} THEN 1 ELSE 0 END), 0) AS refusedCount,
          COALESCE(SUM(CASE WHEN ${PROPAGATED_PARENT_FAILURE_SQL} THEN 1 ELSE 0 END), 0) AS propagatedFailureCount,
          COALESCE(SUM(CASE WHEN ${REUSE_SQL} THEN 1 ELSE 0 END), 0) AS reuseCount,
          COALESCE(SUM(CASE WHEN ${SHADOW_CANDIDATE_SQL} THEN 1 ELSE 0 END), 0) AS shadowCount,
          MAX(tc.created_at)            AS lastAt
       FROM coder_tool_calls tc
       JOIN coder_messages m ON m.id = tc.message_id
       WHERE m.session_id = ?
       GROUP BY tc.tool_name
       ORDER BY count DESC, name ASC`,
    )
    .all(sessionId) as Array<{
      name: string;
      count: number;
      errorCount: number;
      refusedCount: number;
      propagatedFailureCount: number;
      reuseCount: number;
      shadowCount: number;
      lastAt: string | null;
    }>;
  const totalCalls = byNameRows.reduce((acc, r) => acc + r.count, 0);
  const guardOutcomes = byNameRows.reduce<ToolCallStats['guardOutcomes']>((totals, row) => ({
    genuineErrors: totals.genuineErrors + row.errorCount,
    rootRefusals: totals.rootRefusals + row.refusedCount,
    propagatedParentFailures: totals.propagatedParentFailures + row.propagatedFailureCount,
    reusedCalls: totals.reusedCalls + row.reuseCount,
    shadowCandidates: totals.shadowCandidates + row.shadowCount,
  }), {
    genuineErrors: 0,
    rootRefusals: 0,
    propagatedParentFailures: 0,
    reusedCalls: 0,
    shadowCandidates: 0,
  });
  const scopeCounts = db.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN tc.parent_tool_use_id IS NULL THEN 1 ELSE 0 END), 0) AS directCalls,
       COALESCE(SUM(CASE WHEN tc.parent_tool_use_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS nestedCalls
     FROM coder_tool_calls tc
     JOIN coder_messages m ON m.id = tc.message_id
     WHERE m.session_id = ?`,
  ).get(sessionId) as { directCalls: number; nestedCalls: number };
  const cappedLimit = Math.max(1, Math.min(200, Math.floor(recentLimit)));
  const recentRows = db
    .prepare(
      `SELECT
          tc.id          AS id,
          tc.tool_name   AS name,
          tc.args_json   AS args_json,
          tc.is_error    AS isError,
          tc.duration_ms AS durationMs,
          tc.created_at  AS createdAt,
          tc.guard_action AS guardAction,
          tc.guard_reason AS guardReason,
          CASE
            WHEN ${PROPAGATED_PARENT_FAILURE_SQL} THEN 'propagated_parent_failure'
            WHEN ${ROOT_REFUSAL_SQL} THEN 'root_refusal'
            WHEN ${GENUINE_ERROR_SQL} THEN 'genuine_error'
            WHEN ${REUSE_SQL} THEN 'reuse'
            WHEN ${SHADOW_CANDIDATE_SQL} THEN 'shadow'
            ELSE 'success'
          END AS outcome
       FROM coder_tool_calls tc
       JOIN coder_messages m ON m.id = tc.message_id
       WHERE m.session_id = ? AND tc.parent_tool_use_id IS NULL
       ORDER BY tc.id DESC
       LIMIT ?`,
    )
    .all(sessionId, cappedLimit) as Array<{
      id: number; name: string; args_json: string; isError: number;
      durationMs: number; createdAt: string;
      guardAction: string | null; guardReason: string | null;
      outcome: ToolCallStats['recent'][number]['outcome'];
    }>;

  // Savings aggregation — pairs `output_chars` (raw size from the tool) with
  // `output_chars_shaped` (size the LLM actually saw after smart reducer +
  // buildToolResultBlock cap). COALESCE to raw when shaped is NULL so those
  // contribute zero to savings instead of bogus negative deltas.
  const savingsRows = db
    .prepare(
      `SELECT
          tc.tool_name                                              AS name,
          COALESCE(SUM(tc.output_chars), 0)                         AS rawChars,
          COALESCE(SUM(COALESCE(tc.output_chars_shaped, tc.output_chars)), 0) AS shapedChars
       FROM coder_tool_calls tc
       JOIN coder_messages m ON m.id = tc.message_id
       WHERE m.session_id = ? AND tc.parent_tool_use_id IS NULL
       GROUP BY tc.tool_name
       ORDER BY (rawChars - shapedChars) DESC, name ASC`,
    )
    .all(sessionId) as Array<{ name: string; rawChars: number; shapedChars: number }>;

  let totalRawChars = 0;
  let totalShapedChars = 0;
  const byToolSavings = savingsRows.map((r) => {
    totalRawChars += r.rawChars;
    totalShapedChars += r.shapedChars;
    return {
      name: r.name,
      rawChars: r.rawChars,
      shapedChars: r.shapedChars,
      savedChars: Math.max(0, r.rawChars - r.shapedChars),
    };
  });
  const totalSavedChars = Math.max(0, totalRawChars - totalShapedChars);
  const techniqueRows = db.prepare(
    `SELECT
       CASE
         WHEN tc.reduction_kind IS NOT NULL THEN tc.reduction_kind
         WHEN tc.truncated = 1 THEN 'hard_cap'
         ELSE 'none'
       END AS kind,
       COALESCE(tc.reduction_technique,
         CASE
           WHEN tc.truncated = 1 THEN 'legacy-structured-truncated-flag'
           ELSE 'none'
         END) AS technique,
       COUNT(*) AS calls,
       COALESCE(SUM(tc.output_chars), 0) AS rawChars,
       COALESCE(SUM(COALESCE(tc.output_chars_shaped, tc.output_chars)), 0) AS shapedChars
     FROM coder_tool_calls tc
     JOIN coder_messages m ON m.id = tc.message_id
     WHERE m.session_id = ? AND tc.parent_tool_use_id IS NULL
     GROUP BY kind, technique
     ORDER BY (rawChars - shapedChars) DESC`,
  ).all(sessionId) as Array<{ kind: string; technique: string; calls: number; rawChars: number; shapedChars: number }>;
  const nestedVolume = db.prepare(
    `SELECT COALESCE(SUM(tc.output_chars), 0) AS rawChars
       FROM coder_tool_calls tc
       JOIN coder_messages m ON m.id = tc.message_id
      WHERE m.session_id = ? AND tc.parent_tool_use_id IS NOT NULL`,
  ).get(sessionId) as { rawChars: number };
  const byTechnique = techniqueRows.map((r) => ({
    ...r,
    savedChars: Math.max(0, r.rawChars - r.shapedChars),
  }));
  const savedFor = (kind: string): number => byTechnique
    .filter((r) => r.kind === kind)
    .reduce((sum, r) => sum + r.savedChars, 0);

  return {
    totalCalls,
    directCalls: scopeCounts.directCalls,
    nestedCalls: scopeCounts.nestedCalls,
    guardOutcomes,
    byName: byNameRows.map((r) => ({
      name: r.name,
      count: r.count,
      errorCount: r.errorCount,
      refusedCount: r.refusedCount,
      propagatedFailureCount: r.propagatedFailureCount,
      reuseCount: r.reuseCount,
      shadowCount: r.shadowCount,
      lastAt: r.lastAt,
    })),
    recent: recentRows.map((r) => ({
      id: r.id, name: r.name,
      argsPreview: (r.args_json ?? '').slice(0, 200),
      isError: r.isError === 1,
      durationMs: r.durationMs,
      createdAt: r.createdAt,
      outcome: r.outcome,
      guardAction: r.guardAction,
      guardReason: r.guardReason,
    })),
    savings: {
      totalRawChars,
      totalShapedChars,
      totalSavedChars,
      // 4 chars/token is the textbook English heuristic; same as token-accounting.ts
      // when no provider usage is available. Good enough for a "tokens saved" headline.
      totalSavedTokensEst: Math.round(totalSavedChars / 4),
      byTool: byToolSavings.filter((b) => b.savedChars > 0).slice(0, 20),
      semanticSavedChars: savedFor('semantic'),
      jsonCrushSavedChars: savedFor('json_crush'),
      hardCapSavedChars: savedFor('hard_cap'),
      nestedRawChars: nestedVolume.rawChars,
      byTechnique,
    },
  };
}
