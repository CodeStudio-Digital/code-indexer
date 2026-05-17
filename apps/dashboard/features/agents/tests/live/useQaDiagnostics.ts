/**
 * Hook: load the QA diagnostics payload once when the Live tab has no
 * active run. Used to render the empty-state panel with watchdog hits,
 * reporter drift, and endpoint configuration — turning a mute "No QA
 * run in flight" into something the operator can act on.
 *
 * Intentionally does NOT poll. Diagnostics are stable until the QA
 * agent next acts, so a single fetch is enough; the user can click
 * "Restore QA config" / refresh the tab to re-pull.
 */
import { useEffect, useState } from 'react';
import { fetchQaDiagnostics } from '../api/qa-api.js';
import type { QaDiagnostics } from '../shared/types.js';

export interface UseQaDiagnosticsResult {
  data: QaDiagnostics | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useQaDiagnostics(
  sessionId: number,
  enabled: boolean,
): UseQaDiagnosticsResult {
  const [data, setData] = useState<QaDiagnostics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchQaDiagnostics({ sessionId })
      .then((d) => {
        if (cancelled) return;
        setData(d);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, enabled, refreshKey]);

  return {
    data,
    loading,
    error,
    refresh: async () => {
      setRefreshKey((k) => k + 1);
    },
  };
}
