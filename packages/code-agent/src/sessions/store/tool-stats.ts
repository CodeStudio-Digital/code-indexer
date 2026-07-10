import type { Database as DB } from 'better-sqlite3';

export interface ToolCallStats {
  totalCalls: number;
  directCalls: number;
  nestedCalls: number;
  /**
   * `errorCount` = genuine tool failures only; harness refusals (dedup,
   * failure-streak, timeout, …) are split into `refusedCount` so a guard
   * doing its job doesn't read as a flaky tool.
   */
  byName: Array<{ name: string; count: number; errorCount: number; refusedCount: number; lastAt: string | null }>;
  recent: Array<{
    id: number;
    name: string;
    argsPreview: string;
    isError: boolean;
    durationMs: number;
    createdAt: string;
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
  const byNameRows = db
    .prepare(
      `SELECT
          tc.tool_name                  AS name,
          COUNT(*)                      AS count,
          COALESCE(SUM(CASE WHEN tc.is_error = 1 AND tc.refusal_kind IS NULL THEN 1 ELSE 0 END), 0) AS errorCount,
          COALESCE(SUM(CASE WHEN tc.refusal_kind IS NOT NULL THEN 1 ELSE 0 END), 0)                 AS refusedCount,
          MAX(tc.created_at)            AS lastAt
       FROM coder_tool_calls tc
       JOIN coder_messages m ON m.id = tc.message_id
       WHERE m.session_id = ?
       GROUP BY tc.tool_name
       ORDER BY count DESC, name ASC`,
    )
    .all(sessionId) as Array<{ name: string; count: number; errorCount: number; refusedCount: number; lastAt: string | null }>;
  const totalCalls = byNameRows.reduce((acc, r) => acc + r.count, 0);
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
          tc.created_at  AS createdAt
       FROM coder_tool_calls tc
       JOIN coder_messages m ON m.id = tc.message_id
       WHERE m.session_id = ? AND tc.parent_tool_use_id IS NULL
       ORDER BY tc.id DESC
       LIMIT ?`,
    )
    .all(sessionId, cappedLimit) as Array<{
      id: number; name: string; args_json: string; isError: number;
      durationMs: number; createdAt: string;
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
         WHEN tc.truncated = 1 OR tc.result_text LIKE '%[truncated:%' THEN 'hard_cap'
         WHEN tc.result_text LIKE '%json-crush%' THEN 'json_crush'
         WHEN tc.result_text LIKE '%[smart-reducer:%' THEN 'semantic'
         ELSE 'none'
       END AS kind,
       COALESCE(tc.reduction_technique,
         CASE
           WHEN tc.truncated = 1 OR tc.result_text LIKE '%[truncated:%' THEN 'legacy-hard-cap'
           WHEN tc.result_text LIKE '%json-crush%' THEN 'legacy-json-crush'
           WHEN tc.result_text LIKE '%[smart-reducer:%' THEN 'legacy-semantic'
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
    byName: byNameRows.map((r) => ({ name: r.name, count: r.count, errorCount: r.errorCount, refusedCount: r.refusedCount, lastAt: r.lastAt })),
    recent: recentRows.map((r) => ({
      id: r.id, name: r.name,
      argsPreview: (r.args_json ?? '').slice(0, 200),
      isError: r.isError === 1,
      durationMs: r.durationMs,
      createdAt: r.createdAt,
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
