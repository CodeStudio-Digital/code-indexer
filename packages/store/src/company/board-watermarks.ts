// Per-agent "last read board ID" markers so subordinate agents can do
// incremental reads of the company board without keeping `since_id` in
// their own token-eating context. Migration 106.
import type { Database as DB } from 'better-sqlite3';

/**
 * Persist the latest board ID `agentRunId` has consumed. Idempotent UPSERT;
 * the conflict clause keeps the higher of the two values so concurrent
 * calls can't accidentally roll the watermark backwards.
 */
export function set(
  db: DB,
  companySessionId: number,
  agentRunId: number,
  lastSeenBoardId: number,
): void {
  db
    .prepare(
      `INSERT INTO agent_board_watermarks (company_session_id, agent_run_id, last_seen_board_id, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(company_session_id, agent_run_id) DO UPDATE SET
         last_seen_board_id = MAX(last_seen_board_id, excluded.last_seen_board_id),
         updated_at = excluded.updated_at`,
    )
    .run(companySessionId, agentRunId, lastSeenBoardId);
}

/** Returns 0 when no row exists so `> watermark` queries naturally read from the beginning. */
export function get(db: DB, companySessionId: number, agentRunId: number): number {
  const row = db
    .prepare<[number, number], { last_seen_board_id: number }>(
      `SELECT last_seen_board_id FROM agent_board_watermarks
       WHERE company_session_id = ? AND agent_run_id = ?`,
    )
    .get(companySessionId, agentRunId);
  return row?.last_seen_board_id ?? 0;
}

/**
 * Per-agent unread counts for this session. Excludes the agent's own posts
 * via `author_run_id != run_id` so the master doesn't count its own messages
 * as "unread".
 */
export function listUnreadCounts(
  db: DB,
  companySessionId: number,
): Array<{ agentRunId: number; role: string; unreadCount: number }> {
  const rows = db
    .prepare<[number], { agent_run_id: number; role: string; unread_count: number }>(
      `SELECT
         r.id  AS agent_run_id,
         r.role,
         COUNT(b.id) AS unread_count
       FROM company_agent_runs r
       LEFT JOIN agent_board_watermarks w
         ON w.company_session_id = r.company_session_id
        AND w.agent_run_id = r.id
       LEFT JOIN company_board b
         ON b.company_session_id = r.company_session_id
        AND b.id > COALESCE(w.last_seen_board_id, 0)
        AND (b.agent_run_id IS NULL OR b.agent_run_id != r.id)
       WHERE r.company_session_id = ?
       GROUP BY r.id, r.role`,
    )
    .all(companySessionId);
  return rows.map((r) => ({
    agentRunId: r.agent_run_id,
    role: r.role,
    unreadCount: r.unread_count ?? 0,
  }));
}
