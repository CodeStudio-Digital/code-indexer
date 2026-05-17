/**
 * Tab wrapper that wires the existing builder-mode ApiReferenceTab into the
 * company/agents view. Builder sessions already get the API Reference via
 * the right-hand preview pane; for non-builder agent sessions this tab is
 * the only entry point. Keeping a single underlying renderer means any
 * Scalar-side improvements land in both places at once.
 */
import { useEffect, useState } from 'react';
import { ApiReferenceTab, type ServiceOption } from '../builder/preview/api-reference/ApiReferenceTab.js';
import { useSandboxStatus } from '../builder/useSandboxStatus.js';

interface CompanyApiReferenceTabProps {
  sessionId: number;
}

export function CompanyApiReferenceTab({ sessionId }: CompanyApiReferenceTabProps) {
  const { data } = useSandboxStatus(sessionId);

  // Mirror BuilderView's poll cadence so the service list (primary +
  // microservices + attached) stays fresh even when no SSE wiring is
  // active for this view.
  const [extraServices, setExtraServices] = useState<ServiceOption[]>([]);
  useEffect(() => {
    let cancelled = false;
    async function reload() {
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
            is_primary?: boolean;
          }>;
        };
        if (cancelled) return;
        setExtraServices(
          (body.services ?? [])
            // Primary is already injected by ApiReferenceTab from `snapshot`
            // — including it here would double-list it in the switcher.
            .filter((s) => !s.is_primary && !!s.preview_url)
            .map((s) => ({
              id: s.service_id,
              label: s.name || s.service_id,
              previewUrl: s.preview_url!,
              status: s.status,
              runtimePaused: !!s.runtime_paused,
            })),
        );
      } catch {
        /* keep last-known list on transient failure */
      }
    }
    void reload();
    const t = setInterval(reload, 4_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [sessionId]);

  // Same SSE-driven refresh hook BuilderView uses: when the agent writes
  // a new openapi.{yaml,json} file, the runner emits sandbox.file_changed
  // and useCompanyStream dispatches this scoped window event.
  const [fileChangeTick, setFileChangeTick] = useState(0);
  useEffect(() => {
    const eventName = `sandbox:file-changed:${sessionId}`;
    const handler = () => setFileChangeTick((n) => n + 1);
    window.addEventListener(eventName, handler);
    return () => window.removeEventListener(eventName, handler);
  }, [sessionId]);

  return (
    <ApiReferenceTab
      sessionId={sessionId}
      snapshot={data}
      extraServices={extraServices}
      fileChangeTick={fileChangeTick}
    />
  );
}
