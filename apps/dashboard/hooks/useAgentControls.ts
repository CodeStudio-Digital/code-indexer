import { useCallback } from 'react';

/**
 * Per-agent (subordinate) control actions — pause / resume / delete.
 * Extracted from `useCompanyStream` so that already-large hook doesn't
 * grow further. The three calls share the same session-scoped error
 * handling; `deleteAgent` also drops the agent from the live map on
 * success so it disappears from the panel immediately.
 *
 * Pause stops the agent's current turn but keeps its session so it can be
 * resumed; delete aborts it (if running) and removes the agent_run row.
 */
export function useAgentControls(
  companySessionId: string | null,
  streamSetError: (sessionId: string, error: string | null) => void,
  streamRemoveSubordinate: (sessionId: string, agentRunId: string) => void,
  /** null disables raw Company controls (App cards own their lifecycle). */
  controlsBasePath?: string | null,
) {
  const route = useCallback((agentRunId: string, suffix = '') => {
    if (controlsBasePath === null || companySessionId == null) return null;
    const base = controlsBasePath ?? `/api/company/sessions/${companySessionId}/agents`;
    return `${base}/${agentRunId}${suffix}`;
  }, [companySessionId, controlsBasePath]);

  const pauseAgent = useCallback(
    async (agentRunId: string) => {
      if (companySessionId == null) return;
      const url = route(agentRunId, '/pause');
      if (!url) {
        streamSetError(companySessionId, 'Use the App work-item controls to pause this specialist.');
        return;
      }
      try {
        const r = await fetch(url, {
          method: 'POST',
        });
        if (!r.ok && r.status !== 409) {
          const body = await r.text().catch(() => '');
          streamSetError(companySessionId, `Failed to pause agent (${r.status}): ${body}`);
        }
      } catch (e) {
        streamSetError(companySessionId, `Pause error: ${(e as Error).message}`);
      }
    },
    [companySessionId, route, streamSetError],
  );

  const resumeAgent = useCallback(
    async (agentRunId: string, opts?: { message?: string; thinking?: boolean }) => {
      if (companySessionId == null) return;
      const url = route(agentRunId, '/resume');
      if (!url) {
        streamSetError(companySessionId, 'Use the App work-item controls to resume this specialist.');
        return;
      }
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: opts?.message, thinking: opts?.thinking }),
        });
        if (!r.ok && r.status !== 409) {
          const body = await r.text().catch(() => '');
          streamSetError(companySessionId, `Failed to resume agent (${r.status}): ${body}`);
        }
      } catch (e) {
        streamSetError(companySessionId, `Resume error: ${(e as Error).message}`);
      }
    },
    [companySessionId, route, streamSetError],
  );

  const deleteAgent = useCallback(
    async (agentRunId: string) => {
      if (companySessionId == null) return;
      const url = route(agentRunId);
      if (!url) {
        streamSetError(companySessionId, 'Use the App work-item controls to abort this specialist.');
        return;
      }
      try {
        const r = await fetch(url, {
          method: 'DELETE',
        });
        if (r.ok) {
          streamRemoveSubordinate(companySessionId, agentRunId);
        } else {
          const body = await r.text().catch(() => '');
          streamSetError(companySessionId, `Failed to delete agent (${r.status}): ${body}`);
        }
      } catch (e) {
        streamSetError(companySessionId, `Delete error: ${(e as Error).message}`);
      }
    },
    [companySessionId, route, streamSetError, streamRemoveSubordinate],
  );

  return { pauseAgent, resumeAgent, deleteAgent };
}
