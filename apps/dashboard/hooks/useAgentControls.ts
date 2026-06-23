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
  companySessionId: number | null,
  streamSetError: (sessionId: number, error: string | null) => void,
  streamRemoveSubordinate: (sessionId: number, agentRunId: number) => void,
) {
  const pauseAgent = useCallback(
    async (agentRunId: number) => {
      if (companySessionId == null) return;
      try {
        const r = await fetch(`/api/company/sessions/${companySessionId}/agents/${agentRunId}/pause`, {
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
    [companySessionId, streamSetError],
  );

  const resumeAgent = useCallback(
    async (agentRunId: number, opts?: { message?: string; thinking?: boolean }) => {
      if (companySessionId == null) return;
      try {
        const r = await fetch(`/api/company/sessions/${companySessionId}/agents/${agentRunId}/resume`, {
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
    [companySessionId, streamSetError],
  );

  const deleteAgent = useCallback(
    async (agentRunId: number) => {
      if (companySessionId == null) return;
      try {
        const r = await fetch(`/api/company/sessions/${companySessionId}/agents/${agentRunId}`, {
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
    [companySessionId, streamSetError, streamRemoveSubordinate],
  );

  return { pauseAgent, resumeAgent, deleteAgent };
}
