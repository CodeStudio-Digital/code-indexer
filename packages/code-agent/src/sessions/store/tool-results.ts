import type { Database as DB } from 'better-sqlite3';

export interface ToolCallResultRow {
  tool_use_id: string;
  result_text: string;
  is_error: boolean;
  duration_ms: number;
}

/**
 * Audit-table fallback for the dashboard: the recorded results for a set of
 * tool_use ids from `coder_tool_calls`, scoped to one session via the JOIN (so
 * ids can't collide across sessions). Used to reconstruct a tool call's
 * terminal status when its conversational `tool_result` block is missing from
 * `coder_messages` — e.g. sessions written before the paired-persistence fix,
 * where a mid-run compaction dropped the tool message while the audit row
 * survived. Returns only ids that have an audit row.
 */
export function getToolResultsByToolUseIds(
  db: DB,
  sessionId: number,
  toolUseIds: string[],
): ToolCallResultRow[] {
  if (toolUseIds.length === 0) return [];
  const out: ToolCallResultRow[] = [];
  // Chunk to stay under SQLite's bound-parameter limit (999) on huge windows.
  for (let i = 0; i < toolUseIds.length; i += 500) {
    const chunk = toolUseIds.slice(i, i + 500);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT tc.tool_use_id AS tool_use_id, tc.result_text AS result_text,
                tc.is_error AS is_error, tc.duration_ms AS duration_ms
           FROM coder_tool_calls tc
           JOIN coder_messages m ON m.id = tc.message_id
          WHERE m.session_id = ? AND tc.tool_use_id IN (${placeholders})`,
      )
      .all(sessionId, ...chunk) as Array<{
        tool_use_id: string; result_text: string | null; is_error: number; duration_ms: number;
      }>;
    for (const r of rows) {
      out.push({
        tool_use_id: r.tool_use_id,
        result_text: r.result_text ?? '',
        is_error: !!r.is_error,
        duration_ms: r.duration_ms ?? 0,
      });
    }
  }
  return out;
}
