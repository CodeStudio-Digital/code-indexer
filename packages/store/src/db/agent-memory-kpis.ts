import type { DB } from './types.js';

/**
 * Memory-effectiveness KPIs (no LLM) — the measurable loop behind "is the
 * agent actually getting better over time?". Session-owned counters are
 * injected from filesystem bundles; SQLite is read only for the shared
 * Agent Memory catalog and its global recall events.
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

export interface SessionMemoryKpis {
  windowDays: number;
  sessionsInWindow: number;
  learnedSessions: number;
  explicitCalls: Readonly<Record<string, number>>;
}

function safeCount(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

export function getMemoryEffectivenessKpis(
  db: DB,
  projectId: number,
  session: SessionMemoryKpis,
): AgentMemoryKpis {
  const windowDays = Math.max(1, safeCount(session.windowDays));
  const window = `-${windowDays} days`;
  const sessionsInWindow = safeCount(session.sessionsInWindow);
  const learnedSessions = Math.min(
    sessionsInWindow,
    safeCount(session.learnedSessions),
  );
  const explicitCalls: Record<string, number> = {};
  for (const [name, count] of Object.entries(session.explicitCalls)) {
    const safe = safeCount(count);
    if (safe > 0) explicitCalls[name] = safe;
  }
  const kpis: AgentMemoryKpis = {
    windowDays,
    learningRate:
      sessionsInWindow > 0 ? learnedSessions / sessionsInWindow : null,
    sessionsInWindow,
    recallHitRate: null, recallsInWindow: 0,
    usageCoverage: null, liveStock: 0, goldStock: 0,
    explicitCalls,
  };

  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS recalls,
             COALESCE(SUM(CASE WHEN kept > 0 THEN 1 ELSE 0 END), 0) AS hits
      FROM agent_memory_events
      WHERE event_type = 'recall' AND project_id = ? AND created_at >= datetime('now', ?)
      `).get(projectId, window) as { recalls: number; hits: number };
    kpis.recallsInWindow = row.recalls;
    if (row.recalls > 0) kpis.recallHitRate = row.hits / row.recalls;
  } catch { /* best-effort */ }

  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS live,
             COALESCE(SUM(CASE WHEN last_accessed_at >= datetime('now', ?) THEN 1 ELSE 0 END), 0) AS accessed
      FROM agent_memory
      WHERE scope = 'project' AND project_id = ? AND archived_at IS NULL
      `).get(window, projectId) as { live: number; accessed: number };
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

  return kpis;
}
