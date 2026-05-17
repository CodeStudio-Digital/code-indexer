/**
 * Hook: subscribes to the active run for a session and polls every 2s
 * while it's `running`. Returns the run + an array of results emitted
 * so far. When no run is in flight, returns `{ run: null, results: [] }`.
 *
 * Polling instead of SSE in this slice — phase 2D adds republishing on
 * `MetaBusPublisher` so the existing stream pushes incremental updates.
 * Polling at 2s strikes the balance: cheap enough on the network panel,
 * fast enough that the tree feels live.
 */
import { useEffect, useRef, useState } from 'react';
import { fetchActiveRun } from '../api/qa-api.js';
import type { QaRun, QaTestResultWithUrls } from '../shared/types.js';

const POLL_INTERVAL_MS = 2_000;

export interface UseLiveRunResult {
  run: QaRun | null;
  results: QaTestResultWithUrls[];
  loading: boolean;
}

export function useLiveRun(sessionId: number, opts?: { serviceId?: string }): UseLiveRunResult {
  const [run, setRun] = useState<QaRun | null>(null);
  const [results, setResults] = useState<QaTestResultWithUrls[]>([]);
  const [loading, setLoading] = useState(true);
  const cancelledRef = useRef(false);
  const serviceId = opts?.serviceId;

  useEffect(() => {
    cancelledRef.current = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick(): Promise<void> {
      if (cancelledRef.current) return;
      try {
        const data = await fetchActiveRun({ sessionId, serviceId });
        if (cancelledRef.current) return;
        setRun(data.run);
        setResults(data.results ?? []);
        setLoading(false);
        // Keep polling while a run is live; otherwise back off to the
        // history table's poll-on-mount cycle.
        if (data.run && data.run.status === 'running') {
          timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
        }
      } catch {
        // Transient errors don't kill the loop — try again next tick.
        if (cancelledRef.current) return;
        setLoading(false);
        timer = setTimeout(() => void tick(), POLL_INTERVAL_MS * 2);
      }
    }

    void tick();
    return () => {
      cancelledRef.current = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId, serviceId]);

  return { run, results, loading };
}
