/**
 * Fetch `/api/company/sessions/:id/services` once on mount + refetch
 * on sandbox service events.
 *
 * Naming kept for backward-compat — the hook used to poll every 5 s.
 * Post-P14b it's purely SSE-driven: any `sandbox.service.*` event
 * bumps `sandboxSlice.servicesSeq`, and this hook re-runs its fetch
 * on the bump. A 5 s polling fallback fires ONLY when the company
 * stream is disconnected.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  selectSandbox,
  selectStream,
  useCompanyStore,
} from '../../../state/company/index.js';
import type { ServiceRow } from './types.js';

export interface UseServicesPollingResult {
  services: ServiceRow[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  /** Setter exposed so the caller can clear errors after their own retries. */
  setError: (msg: string | null) => void;
}

const DISCONNECTED_HEARTBEAT_MS = 5_000;

export function useServicesPolling(sessionId: string): UseServicesPollingResult {
  const { t } = useTranslation('agents');
  const [services, setServices] = useState<ServiceRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualSeq, setManualSeq] = useState(0);

  const servicesSeq = useCompanyStore((s) => selectSandbox(s, sessionId).servicesSeq);
  const connected = useCompanyStore((s) => selectStream(s, sessionId).connected);

  async function reload(): Promise<void> {
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

  // Initial fetch + refetch on service events / manual refresh.
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, servicesSeq, manualSeq]);

  // Disconnected-only fallback: tick a manual refresh every 5 s when
  // the company SSE stream is closed (dormant session). Cleared as
  // soon as the stream reconnects and event-driven refresh resumes.
  useEffect(() => {
    if (connected) return;
    const id = setInterval(() => setManualSeq((n) => n + 1), DISCONNECTED_HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [connected]);

  return { services, loading, error, reload, setError };
}
