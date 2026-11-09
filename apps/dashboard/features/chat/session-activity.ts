import type { AgentSessionActivity } from '../../hooks/agent-stream/session-stream-store.js';

export interface RuntimeActivity { active: Array<{ session_id: string; bus_id: string | null }> }
interface SessionActivityRow { id: string; status: string; runtime_active?: boolean; runtime_bus_id?: string | null }

export function isExecutingSessionStatus(status: string): boolean {
  return ['running', 'in_progress', 'working'].includes(status.trim().toLowerCase());
}

/** Explicit terminal events outrank a stale list/poll for the same run. */
export function executingSessionIds(
  sessions: readonly SessionActivityRow[],
  live: Readonly<Record<string, AgentSessionActivity>>,
  runtime: RuntimeActivity | null,
): Set<string> {
  const active = new Map(runtime?.active.map(item => [item.session_id, item.bus_id]));
  return new Set(sessions.filter(session => {
    const local = live[session.id];
    if (local?.active) return true;
    const busId = runtime ? active.get(session.id) : session.runtime_bus_id;
    if (local?.terminal && (!busId || busId === local.busId)) return false;
    return runtime ? active.has(session.id) : (session.runtime_active ?? isExecutingSessionStatus(session.status));
  }).map(session => session.id));
}
