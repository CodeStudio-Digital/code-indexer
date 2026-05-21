/**
 * Polls `GET /api/docs/sources/:id/progress` every 2 seconds while the
 * caller indicates `active` (typically when the source row's status is
 * `fetching` or `indexing`). Stops cleanly when `active` flips false or
 * the component unmounts.
 *
 * Why polling and not SSE re-attach: the dialog-bound SSE stream is tied
 * to the request that started the run. Re-attaching across runs would
 * require a multi-consumer bus on the server (significantly more code).
 * Polling 2s gives 95% of the UX for 10% of the effort. If we ever
 * exceed ~50 sources in flight per process, swap to SSE.
 */
import { useEffect, useState } from 'react';
import type { DocIngestProgressFrame } from './docs-api.js';

interface ProgressResponse {
  active: boolean;
  status: string;
  snapshot?: DocIngestProgressFrame & { source_id: number; updated_at: number };
}

export function useSourceProgress(
  sourceId: number,
  active: boolean,
  intervalMs: number = 2_000,
): DocIngestProgressFrame | null {
  const [snapshot, setSnapshot] = useState<DocIngestProgressFrame | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/docs/sources/${sourceId}/progress`);
        if (!r.ok) return;
        const data = (await r.json()) as ProgressResponse;
        if (cancelled) return;
        if (data.snapshot) setSnapshot(data.snapshot);
      } catch {
        /* polling errors are non-fatal — try again next tick */
      }
    };
    void tick();
    const id = window.setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [sourceId, active, intervalMs]);

  return snapshot;
}
