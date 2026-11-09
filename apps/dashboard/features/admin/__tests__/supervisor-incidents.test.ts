import { expect, it } from 'vitest';
import { mergeSupervisorIncidents } from '../supervisor-incidents.js';
import type { IncidentRow } from '../supervisor-api.js';

it('deduplicates replay/live/history and drops events from the previous session', () => {
  const live = { sessionId: 's1', agentRunId: 'a1', kind: 'stuck_detected', detail: 'slow tool', detectedAtMs: 123 };
  const persisted = { id: 'persisted-1', companySessionId: 's1', agentRunId: 'a1', incidentKind: live.kind, detail: live.detail, detectedAtMs: 123 } as IncidentRow;
  const result = mergeSupervisorIncidents([persisted], [live, live, { ...live, sessionId: 's2' }], 's1');
  expect(result).toHaveLength(1); expect(result[0].live).toBe(false);
});
