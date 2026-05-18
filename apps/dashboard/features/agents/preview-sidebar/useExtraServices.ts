import { useEffect, useState } from 'react';
import type { ServiceOption } from '../../builder/preview/api-reference/ApiReferenceTab.js';

/**
 * Poll `/api/company/sessions/:id/services` and project the response
 * into the `ServiceOption[]` shape expected by `PreviewIframe`.
 *
 * Both `PreviewSidebar` (agents view) and `CompanyApiReferenceTab` use
 * this — sharing the hook keeps the polling cadence consistent and
 * avoids two parallel intervals when the same session has both panels
 * open. Phase 4 will replace the poll with SSE `service.*` events
 * once the backend publishes them; consumers won't need to change.
 *
 * The primary service is filtered out because `PreviewIframe` already
 * gets it from `snapshot.sandbox.previewUrl`. Including it here would
 * double-list it in the service switcher.
 */
export function useExtraServices(sessionId: number | null, intervalMs = 4_000): ServiceOption[] {
  const [services, setServices] = useState<ServiceOption[]>([]);

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
    const handle = setInterval(reload, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [sessionId, intervalMs]);

  return services;
}
