import React from 'react';
import { CompanySessionView } from '../agents/CompanySessionView.js';
import { PreviewPanel } from './PreviewPanel.js';
import { useSandboxStatus } from './useSandboxStatus.js';

/**
 * BuilderView — split layout rendered for company sessions that were
 * created with a `builder.stack`. Left pane is the existing
 * `CompanySessionView` (chat + board + kanban), right pane is the
 * live sandbox preview.
 *
 * Reuses the chat/board/composer from `CompanySessionView` verbatim
 * (DRY). The only thing new is the right-hand `PreviewPanel`.
 *
 * Resizable layout: we use CSS grid with a `resize` affordance on the
 * split border rather than pulling in `react-resizable-panels`. This
 * keeps the zero-new-deps posture of the rest of the feature. Users
 * can drag the divider to expand either side; the ratio persists in
 * localStorage per-session.
 */

export interface BuilderViewProps {
  sessionId: number;
  sessionName: string;
  sessionStatus: string;
}

export function BuilderView({ sessionId, sessionName, sessionStatus }: BuilderViewProps) {
  const { data, refresh, retry, restartDev } = useSandboxStatus(sessionId);
  const [leftPct, setLeftPct] = usePersistedRatio(sessionId, 0.55);
  // Monotonically-incrementing counter bumped whenever the server emits
  // `sandbox.file_changed` for this session. `useCompanyStream` (mounted
  // inside `CompanySessionView` below) dispatches a scoped window event;
  // we pick it up here so PreviewPanel can auto-reload the iframe
  // without either component having to share state via props.
  const [fileChangeTick, setFileChangeTick] = React.useState(0);
  React.useEffect(() => {
    const eventName = `sandbox:file-changed:${sessionId}`;
    const handler = () => setFileChangeTick((n) => n + 1);
    window.addEventListener(eventName, handler);
    return () => window.removeEventListener(eventName, handler);
  }, [sessionId]);

  // Poll the multi-service list so the preview's switcher dropdown
  // sees additions/removals without relying on the sandbox.service.*
  // SSE event wiring. 4s cadence balances freshness vs load — the
  // add/remove flows complete in tens of seconds anyway.
  const [extraServices, setExtraServices] = React.useState<
    Array<{ id: string; label: string; previewUrl: string; status: string }>
  >([]);
  React.useEffect(() => {
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
            preview_url: string | null;
          }>;
        };
        if (cancelled) return;
        setExtraServices(
          (body.services ?? [])
            .filter((s) => !!s.preview_url)
            .map((s) => ({
              id: s.service_id,
              label: s.name || s.service_id,
              previewUrl: s.preview_url!,
              status: s.status,
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

  const draggingRef = React.useRef(false);
  const containerRef = React.useRef<HTMLDivElement | null>(null);

  // Degradation path: when this session was not created with builder
  // config, just render the traditional CompanySessionView full-bleed.
  // This lets AgentsTab route EVERY session through BuilderView without
  // needing to check the builder flag itself — less branching up-stack.
  if (data && !data.builder) {
    return (
      <CompanySessionView
        sessionId={sessionId}
        sessionName={sessionName}
        sessionStatus={sessionStatus}
      />
    );
  }

  // Minimal drag handler — converts clientX to a percentage and clamps
  // so neither pane collapses below 20%.

  function startDrag(e: React.PointerEvent<HTMLDivElement>) {
    draggingRef.current = true;
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }
  function onDrag(e: React.PointerEvent<HTMLDivElement>) {
    if (!draggingRef.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const pct = Math.min(0.8, Math.max(0.2, (e.clientX - rect.left) / rect.width));
    setLeftPct(pct);
  }
  function endDrag(e: React.PointerEvent<HTMLDivElement>) {
    draggingRef.current = false;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
  }

  return (
    <div ref={containerRef} className="flex h-full w-full min-h-0">
      <div style={{ width: `${leftPct * 100}%` }} className="min-w-0 flex flex-col">
        <CompanySessionView
          sessionId={sessionId}
          sessionName={sessionName}
          sessionStatus={sessionStatus}
        />
      </div>
      {/* Drag handle. `cursor-col-resize` + a 4px hit area keeps the
          divider unobtrusive but grabbable. */}
      <div
        onPointerDown={startDrag}
        onPointerMove={onDrag}
        onPointerUp={endDrag}
        className="w-1 bg-border hover:bg-primary/40 cursor-col-resize flex-shrink-0"
        role="separator"
        aria-orientation="vertical"
      />
      <div style={{ width: `${(1 - leftPct) * 100}%` }} className="min-w-0">
        <PreviewPanel
          snapshot={data}
          onRefresh={refresh}
          onRetry={retry}
          onRestartDev={restartDev}
          sessionId={sessionId}
          fileChangeTick={fileChangeTick}
          extraServices={extraServices}
        />
      </div>
    </div>
  );
}

function usePersistedRatio(sessionId: number, fallback: number): [number, (n: number) => void] {
  const key = `mcp.builder.split.${sessionId}`;
  const [value, setValue] = React.useState<number>(() => {
    if (typeof window === 'undefined') return fallback;
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0.1 && n < 0.9 ? n : fallback;
  });
  function set(n: number) {
    setValue(n);
    try {
      window.localStorage.setItem(key, String(n));
    } catch {
      /* storage quota / privacy mode — ignore */
    }
  }
  return [value, set];
}
