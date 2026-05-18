/**
 * Poll `/api/company/sessions/:id/services` every 5s while mounted.
 *
 * Manual SSE replacement would be a follow-up; until then 5s polling
 * is enough granularity for the status transitions users actually
 * notice (provisioning → ready, ready → error). Polling is paused
 * implicitly when the panel unmounts via the cleanup return.
 *
 * Extracted from `ServicesSidebar.tsx` so the sidebar component itself
 * stays focused on render decisions, and the polling logic can be
 * reused/tested in isolation.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ServiceRow } from './types.js';

export interface UseServicesPollingResult {
  services: ServiceRow[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  /** Setter exposed so the caller can clear errors after their own retries. */
  setError: (msg: string | null) => void;
}

export function useServicesPolling(sessionId: number): UseServicesPollingResult {
  const { t } = useTranslation('agents');
  const [services, setServices] = useState<ServiceRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    setLoading(true);
    try {
      const r = await fetch(`/api/company/sessions/${sessionId}/services`);
      if (r.ok) {
        const body = (await r.json()) as { services: ServiceRow[] };
        setServices(body.services ?? []);
        setError(null);
      }
    } catch {
      setError(t('services.errorLoading'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
    // Poll every 5s while the panel is open so status transitions
    // (provisioning → ready) surface without a dedicated SSE stream.
    const interval = setInterval(reload, 5_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  return { services, loading, error, reload, setError };
}
