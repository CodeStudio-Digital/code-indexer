import type { DB } from './types.js';

/**
 * Memory-effectiveness KPIs (100% SQL, no LLM) — the measurable loop behind
 * "is the agent actually getting better over time?". Rendered as chips on the
 * AgentMemoryHealthCard; window is the last 30 days. Every query is
 * best-effort (a trimmed per-project DB may lack the session/tool tables).
 *
 *  K1 learningRate  — % of sessions that produced ≥1 memory (created+merged)
 *  K2 recallHitRate — % of proactive/explicit recalls that injected ≥1 memory
 *  K3 usageCoverage — % of the live project stock accessed in the window
 *                     (markAccessed only fires on injected/recalled items —
 *                     the computable proxy for "injected AND used")
 *  K4 goldStock     — live `preference` memories (user scope + this project)
 *  K5 explicitCalls — recall_memory / remember / forget_memory tool calls
 */
export interface AgentMemoryKpis {
  windowDays: number;
  learningRate: number | null;
  sessionsInWindow: number;
  recallHitRate: number | null;
  recallsInWindow: number;
  usageCoverage: number | null;
  liveStock: number;
  goldStock: number;
  explicitCalls: Record<string, number>;
}

const WINDOW_DAYS = 30;
const WINDOW = `-${WINDOW_DAYS} days`;

export function getMemoryEffectivenessKpis(db: DB, projectId: number): AgentMemoryKpis {
  const kpis: AgentMemoryKpis = {
    windowDays: WINDOW_DAYS,
    learningRate: null, sessionsInWindow: 0,
    recallHitRate: null, recallsInWindow: 0,
    usageCoverage: null, liveStock: 0, goldStock: 0,
    explicitCalls: {},
  };

  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS sessions,
             SUM(CASE WHEN learned > 0 THEN 1 ELSE 0 END) AS learnedSessions
      FROM (
        SELECT s.id,
               (SELECT COALESCE(SUM(l.created + l.merged), 0)
                  FROM memory_distill_log l WHERE l.session_id = s.id) AS learned
        FROM coder_sessions s
        WHERE s.project_id = ? AND s.created_at >= datetime('now', ?)
      )`).get(projectId, WINDOW) as { sessions: number; learnedSessions: number | null };
    kpis.sessionsInWindow = row.sessions;
    if (row.sessions > 0) kpis.learningRate = (row.learnedSessions ?? 0) / row.sessions;
  } catch { /* central tables absent on trimmed DBs */ }

  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS recalls,
             COALESCE(SUM(CASE WHEN kept > 0 THEN 1 ELSE 0 END), 0) AS hits
      FROM agent_memory_events
      WHERE event_type = 'recall' AND project_id = ? AND created_at >= datetime('now', ?)
      `).get(projectId, WINDOW) as { recalls: number; hits: number };
    kpis.recallsInWindow = row.recalls;
    if (row.recalls > 0) kpis.recallHitRate = row.hits / row.recalls;
  } catch { /* best-effort */ }

  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS live,
             COALESCE(SUM(CASE WHEN last_accessed_at >= datetime('now', ?) THEN 1 ELSE 0 END), 0) AS accessed
      FROM agent_memory
      WHERE scope = 'project' AND project_id = ? AND archived_at IS NULL
      `).get(WINDOW, projectId) as { live: number; accessed: number };
    kpis.liveStock = row.live;
    if (row.live > 0) kpis.usageCoverage = row.accessed / row.live;
  } catch { /* best-effort */ }

  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS c FROM agent_memory
      WHERE archived_at IS NULL AND type = 'preference'
        AND (scope = 'user' OR (scope = 'project' AND project_id = ?))
      `).get(projectId) as { c: number };
    kpis.goldStock = row.c;
  } catch { /* best-effort */ }

  try {
    const rows = db.prepare(`
      SELECT tc.tool_name AS name, COUNT(*) AS c
      FROM coder_tool_calls tc
      JOIN coder_messages cm ON cm.id = tc.message_id
      JOIN coder_sessions s ON s.id = cm.session_id
      WHERE s.project_id = ?
        AND tc.tool_name IN ('recall_memory', 'remember', 'forget_memory')
        AND tc.created_at >= datetime('now', ?)
      GROUP BY tc.tool_name
      `).all(projectId, WINDOW) as Array<{ name: string; c: number }>;
    for (const r of rows) kpis.explicitCalls[r.name] = r.c;
  } catch { /* best-effort */ }

  return kpis;
}
