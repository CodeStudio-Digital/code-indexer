import type { SupervisorStatus } from '@mcp/company/services/supervisor/index.js';
import type { CompanySessionId } from '@mcp/session-storage';

interface StatusPool {
  activeSessionIds(): CompanySessionId[];
  supervisorRpc(sessionId: CompanySessionId, method: 'getStatus'): Promise<unknown>;
}

export async function readSupervisorStatus(pool: StatusPool, sessionId?: CompanySessionId, enabled = true) {
  const active = pool.activeSessionIds();
  const ids = sessionId ? active.filter((id) => id === sessionId) : active;
  if (!enabled) return { enabled: false, availability: 'disabled' as const, sessions: [] };
  if (!ids.length) return { enabled: true, availability: 'idle' as const, sessions: [] };
  const sessions = await Promise.all(ids.map(async (id) => {
    try {
      const status = await pool.supervisorRpc(id, 'getStatus') as SupervisorStatus | null;
      const fresh = status?.lastTickAtMs == null || Date.now() - status.lastTickAtMs < 60000;
      return { sessionId: id, status, availability: status ? (status.isRunning && fresh ? 'active' : 'unavailable') : 'disabled' };
    } catch {
      return { sessionId: id, status: null, availability: 'unavailable' };
    }
  }));
  const availability = sessions.some((row) => row.availability === 'unavailable') ? 'unavailable'
    : sessions.some((row) => row.availability === 'active') ? 'active' : 'disabled';
  return { enabled: availability !== 'disabled', availability, sessions };
}
