/**
 * Fetches `GET /api/docs/sources/:id/health` on demand. Unlike
 * `useSourceProgress` (which polls every 2s while active), health is a
 * post-completion view — we fetch once on mount + when the row's
 * `updated_at` flips (re-index landed, retry finished, etc.), and on
 * explicit `refetch()` from the caller (e.g. after a Re-embedar action).
 */
import { useCallback, useEffect, useState } from 'react';
import { fetchSourceHealth, type DocSourceHealth } from './docs-api.js';

export function useSourceHealth(sourceId: number, cacheBuster: string | number = '') {
  const [health, setHealth] = useState<DocSourceHealth | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setHealth(await fetchSourceHealth(sourceId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [sourceId]);

  useEffect(() => {
    void refetch();
    // The cacheBuster (typically `source.updated_at`) lets the parent
    // tell the hook "row changed — re-pull". Without it, the hook never
    // observes server-side changes after the initial fetch.
  }, [refetch, cacheBuster]);

  return { health, loading, error, refetch };
}
