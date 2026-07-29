import { useEffect, useState } from 'react';
import {
  selectSandbox,
  selectStream,
  useCompanyStore,
} from '../../../state/company/index.js';
import type { ServiceOption } from '../../builder/preview/api-reference/ApiReferenceTab.js';

/**
 * Fetch `/api/company/sessions/:id/services` once and refetch only
 * on backend service events (`sandbox.service.*`).
 *
 * Both `SidebarPanels` (agents view) and `CompanyApiReferenceTab` use
 * this — sharing the hook keeps every consumer aligned on one source
 * of truth. Post-P14b the hook is purely SSE-driven; a slow polling
 * fallback (5 s) only kicks in when the company stream is disconnected
 * so a dormant session still surfaces newly-added services.
 *
 * The primary service is filtered out because `PreviewIframe` already
 * gets it from `snapshot.sandbox.previewUrl`. Including it here would
 * double-list it in the service switcher.
 */
const DISCONNECTED_HEARTBEAT_MS = 5_000;

export function useExtraServices(sessionId: string | null): ServiceOption[] {
  const [services, setServices] = useState<ServiceOption[]>([]);
  const [manualSeq, setManualSeq] = useState(0);

  const servicesSeq = useCompanyStore((s) =>
    sessionId == null ? 0 : selectSandbox(s, sessionId).servicesSeq,
  );
  const connected = useCompanyStore((s) =>
    sessionId == null ? false : selectStream(s, sessionId).connected,
  );

  useEffect(() => {
    if (sessionId == null) return;
    let cancelled = false;

    async function reload(): Promise<void> {
      try {
        const r = await fetch(`/api/company/sessions/${sessionId}/services`);
        if (!r.ok) return;
        const body = (await r.json()) as {
          services: Array<{
            service_id: string;
            name: string;
            status: string;
            runtime_paused?: boolean;
            preview_url: string | null;
            preview_strategy?: 'proxy-prefix' | 'proxy-root' | 'port-direct';
            host_port?: number;
            is_primary?: boolean;
          }>;
        };
        if (cancelled) return;
        setServices(
          (body.services ?? [])
            .filter((s) => !s.is_primary && !!s.preview_url)
            .map((s) => ({
              id: s.service_id,
              label: s.name || s.service_id,
              previewUrl: s.preview_url!,
              status: s.status,
              runtimePaused: !!s.runtime_paused,
              previewStrategy: s.preview_strategy,
              hostPort: s.host_port,
            })),
        );
      } catch {
        /* keep last-known list on transient failure */
      }
    }

    void reload();
    return () => {
      cancelled = true;
    };
  }, [sessionId, servicesSeq, manualSeq]);

  // Disconnected-only fallback. As soon as the company stream
  // reconnects this interval clears itself and event-driven refresh
  // takes over.
  useEffect(() => {
    if (sessionId == null || connected) return;
    const id = setInterval(() => setManualSeq((n) => n + 1), DISCONNECTED_HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [sessionId, connected]);

  return services;
}
