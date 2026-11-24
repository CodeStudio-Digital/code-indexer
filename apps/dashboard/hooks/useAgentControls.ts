import { useCallback, useRef } from 'react';
import type { CompanyPanelReceipt } from '@mcp/company-contracts';
import { applyCompanyPanelReceipt } from '../lib/company-panel-changes.js';

/** A receipt can arrive over SSE before the HTTP response, including after a cold resume. */
export function useAgentControls(
  sessionId: string | null,
  setError: (sessionId: string, error: string | null) => void,
  controlsBasePath?: string | null,
) {
  const pending = useRef(new Set<string>());
  const control = useCallback(async (id: string, action: 'pause' | 'resume' | 'delete', body?: { message?: string; thinking?: boolean }) => {
    if (!sessionId) return;
    if (controlsBasePath === null) {
      setError(sessionId, 'Use the App work-item controls for this specialist.');
      return;
    }
    const base = controlsBasePath ?? `/api/company/sessions/${sessionId}/agents`;
    const path = `${base}/${id}`;
    if (pending.current.has(path)) return;
    pending.current.add(path);
    setError(sessionId, null);
    try {
      const res = await fetch(action === 'delete' ? path : `${path}/${action}`, {
        method: action === 'delete' ? 'DELETE' : 'POST',
        ...(action === 'resume' && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }),
      });
      const result = await res.json().catch(() => null) as { error?: string; receipt?: CompanyPanelReceipt } | null;
      if (!res.ok) throw new Error(result?.error ?? `HTTP ${res.status}`);
      if (result?.receipt) applyCompanyPanelReceipt(result.receipt);
    } catch (err) {
      setError(sessionId, err instanceof Error ? err.message : String(err));
    } finally {
      pending.current.delete(path);
    }
  }, [sessionId, controlsBasePath, setError]);

  return {
    pauseAgent: useCallback((id: string) => control(id, 'pause'), [control]),
    resumeAgent: useCallback((id: string, body?: { message?: string; thinking?: boolean }) => control(id, 'resume', body), [control]),
    deleteAgent: useCallback((id: string) => control(id, 'delete'), [control]),
  };
}
