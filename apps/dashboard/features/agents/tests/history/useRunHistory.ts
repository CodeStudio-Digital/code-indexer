/**
 * Hook: list past runs for a session, with refresh + a polling loop
 * while there's an active run (so the table picks up the freshly
 * completed row without the user reloading).
 *
 * Polling cadence: 4s — same as the company services polls, kept
 * consistent so the network panel doesn't blink with mismatched frequencies.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchRuns } from '../api/qa-api.js';
import type { QaRun } from '../shared/types.js';

const POLL_INTERVAL_MS = 4_000;

interface UseRunHistoryResult {
  runs: QaRun[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useRunHistory(
  sessionId: string,
  opts?: { pollWhenActive?: boolean; serviceId?: string },
): UseRunHistoryResult {
  const [runs, setRuns] = useState<QaRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  const serviceId = opts?.serviceId;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const { runs } = await fetchRuns({ sessionId, serviceId, limit: 50 });
      if (cancelledRef.current) return;
      setRuns(runs);
      setError(null);
    } catch (e) {
      if (cancelledRef.current) return;
      setError((e as Error).message);
    } finally {
      if (!cancelledRef.current) setLoading(false);
    }
  }, [sessionId, serviceId]);

  useEffect(() => {
    cancelledRef.current = false;
    void refresh();
    return () => {
      cancelledRef.current = true;
    };
  }, [refresh]);

  // Polling while a run is in-flight: any row with status='running'
  // means the suite is reporting incrementally; we want the table to
  // reflect the new state as soon as it transitions to completed.
  useEffect(() => {
    if (!opts?.pollWhenActive) return;
    const hasActive = runs.some((r) => r.status === 'running');
    if (!hasActive) return;
    const t = setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [runs, opts?.pollWhenActive, refresh]);

  return { runs, loading, error, refresh };
}
