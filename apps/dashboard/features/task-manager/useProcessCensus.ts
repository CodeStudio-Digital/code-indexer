/**
 * Polling + kill transport for the task manager.
 *
 * `usePolling` already pauses while the window is hidden, which matters more
 * here than elsewhere: the backend collector shuts itself down after ~20s
 * without a request, so a minimised task-manager window costs nothing at all.
 *
 * Rows are replaced wholesale on each tick rather than reconciled. The backend
 * sorts siblings deterministically (memory desc, pid asc), so a row only moves
 * when the underlying numbers actually reorder it.
 */
import { useCallback, useState } from 'react';
import { apiBaseUrl } from '../../lib/api-client.js';
import { usePolling } from '../../hooks/usePolling.js';
import type { ProcessSnapshot } from './columns.js';

export interface KillOutcome {
  ok: boolean;
  /** Machine-readable denial reason (`main_process_protected`, …). */
  code?: string;
  message?: string;
}

export function useProcessCensus(intervalMs: number): {
  snapshot: ProcessSnapshot | null;
  error: string | null;
  refresh: () => void;
  kill: (pid: number, mode: 'graceful' | 'force') => Promise<KillOutcome>;
} {
  const [snapshot, setSnapshot] = useState<ProcessSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void (async () => {
      try {
        const r = await fetch(`${apiBaseUrl()}/api/admin/processes?intervalMs=${intervalMs}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        setSnapshot((await r.json()) as ProcessSnapshot);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [intervalMs]);

  usePolling(refresh, intervalMs);

  const kill = useCallback(async (pid: number, mode: 'graceful' | 'force') => {
    try {
      const r = await fetch(`${apiBaseUrl()}/api/admin/processes/kill`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pid, mode }),
      });
      const body = (await r.json()) as { ok?: boolean; code?: string; error?: string };
      // Refresh immediately: a successful kill should leave the list correct
      // now, not up to `intervalMs` later.
      refresh();
      if (!r.ok || !body.ok) return { ok: false, code: body.code, message: body.error };
      return { ok: true };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }, [refresh]);

  return { snapshot, error, refresh, kill };
}
