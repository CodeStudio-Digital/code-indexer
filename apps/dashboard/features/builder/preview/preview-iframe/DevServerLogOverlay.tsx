import React, { useEffect, useRef, useState } from 'react';
import { Terminal, X } from 'lucide-react';

interface Props {
  sessionId: number;
  serviceId: string | null;
  onClose: () => void;
}

/**
 * Polls `/api/company/sessions/:id/sandbox/logs` at 2s cadence while open.
 * Shown over the iframe (doesn't unmount it, so HMR state survives when
 * the user closes the overlay).
 */
export function DevServerLogOverlay({ sessionId, serviceId, onClose }: Props) {
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [portStatus, setPortStatus] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const scrollerRef = useRef<HTMLPreElement | null>(null);

  const logUrl = serviceId
    ? `/api/company/sessions/${sessionId}/services/${encodeURIComponent(serviceId)}/logs?lines=500`
    : `/api/company/sessions/${sessionId}/sandbox/logs?lines=500`;

  async function restartDev() {
    setRestarting(true);
    try {
      const url = serviceId
        ? `/api/company/sessions/${sessionId}/services/${encodeURIComponent(serviceId)}/restart-dev`
        : `/api/company/sessions/${sessionId}/sandbox/restart-dev`;
      await fetch(url, { method: 'POST' });
    } finally {
      setRestarting(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const res = await fetch(logUrl, { credentials: 'include' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { devServer: string; portStatus?: string };
        if (!cancelled) {
          setContent(json.devServer || '(dev-server has not emitted any output yet)');
          setPortStatus(json.portStatus ?? null);
          setErr(null);
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setErr(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      }
    }
    tick();
    const id = setInterval(tick, 2_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [logUrl]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [content]);

  return (
    <div className="absolute inset-0 z-10 bg-background/95 flex flex-col">
      <div className="h-10 flex items-center gap-2 px-3 border-b">
        <Terminal className="h-3.5 w-3.5" />
        <span className="text-xs font-medium">
          Dev-server logs{serviceId ? ` — ${serviceId}` : ''}
        </span>
        <span className="text-[10px] text-muted-foreground">(auto-refreshes every 2s)</span>
        {portStatus && (
          <span
            className={
              'text-[10px] px-1.5 rounded ' +
              (portStatus === 'listening' ? 'text-emerald-500' : 'text-red-500')
            }
          >
            port {portStatus}
          </span>
        )}
        <div className="flex-1" />
        <button
          onClick={restartDev}
          disabled={restarting}
          className="px-2 py-1 text-[11px] rounded-md border hover:bg-muted disabled:opacity-40"
          title="Kill and relaunch the dev-server process inside the container"
        >
          {restarting ? 'Restarting…' : 'Restart dev-server'}
        </button>
        <button onClick={onClose} className="p-1.5 rounded-md hover:bg-muted" title="Close">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <pre
        ref={scrollerRef}
        className="flex-1 overflow-auto p-3 m-0 font-mono text-[11px] leading-snug whitespace-pre-wrap"
      >
        {loading ? 'Loading…' : err ? `Failed to load logs: ${err}` : content}
      </pre>
    </div>
  );
}
