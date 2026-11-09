import type { IncidentRow, SupervisorIncidentEnvelope } from './supervisor-api.js';

export function mergeSupervisorIncidents(history: IncidentRow[], live: SupervisorIncidentEnvelope[], sessionId?: string) {
  const seen = new Set<string>();
  return [
    ...history.map((row) => ({ sessionId: row.companySessionId ?? 'unknown', kind: row.incidentKind, agentRunId: row.agentRunId,
      detail: row.detail, detectedAtMs: row.detectedAtMs, live: false })),
    ...live.map((row) => ({ ...row, live: true })),
  ].filter((row) => {
    if (sessionId && row.sessionId !== sessionId) return false;
    const key = JSON.stringify([row.sessionId, row.agentRunId, row.kind, row.detectedAtMs, row.detail]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => b.detectedAtMs - a.detectedAtMs);
}
