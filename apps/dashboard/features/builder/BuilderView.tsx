import React from 'react';
import { CompanySessionView } from '../agents/CompanySessionView.js';
import { useExtraServices } from '../agents/preview-sidebar/useExtraServices.js';
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
  /** Forwarded to `CompanySessionView` so its header can host the
   *  sessions-list toggle owned by `AgentsTab`. */
  sessionsListOpen?: boolean;
  onToggleSessionsList?: () => void;
}

export function BuilderView({
  sessionId,
  sessionName,
  sessionStatus,
  sessionsListOpen,
  onToggleSessionsList,
}: BuilderViewProps) {
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

  // Multi-service list for the preview switcher. Post-P14b this reads
  // from the shared SSE-driven `useExtraServices` hook instead of the
  // legacy 4 s setInterval that used to live here and a separate
  // duplicate in the preview-sidebar hook. One source of truth, zero
  // polling while the company SSE stream is alive.
  const extraServices = useExtraServices(sessionId);

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
        sessionsListOpen={sessionsListOpen}
        onToggleSessionsList={onToggleSessionsList}
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
      <div style={{ width: `${100}%` }} className="min-w-0 flex flex-col">
        <CompanySessionView
          sessionId={sessionId}
          sessionName={sessionName}
          sessionStatus={sessionStatus}
          sessionsListOpen={sessionsListOpen}
          onToggleSessionsList={onToggleSessionsList}
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
