/**
 * Hook: latest QA run for a session (any status). Refreshes on mount,
 * returns `null` when there isn't one yet. Lightweight — only fetches
 * the first row.
 *
 * Used by the header badge so the user gets an at-a-glance status of
 * the most recent QA verdict without opening the Tests tab.
 */
import { useEffect, useState } from 'react';
import { fetchRuns } from '../api/qa-api.js';
import type { QaRun } from './types.js';

export function useLastQaRun(sessionId: number, refreshKey?: number): QaRun | null {
  const [run, setRun] = useState<QaRun | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchRuns({ sessionId, limit: 1 })
      .then((d) => {
        if (cancelled) return;
        setRun(d.runs[0] ?? null);
      })
      .catch(() => {
        // Silent — header badge degrades to invisible on error.
        if (!cancelled) setRun(null);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, refreshKey]);

  return run;
}
