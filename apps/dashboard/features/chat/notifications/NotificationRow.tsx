/**
 * Shared chrome for one session notification — used both in the active banner
 * strip (`mode="banner"`: dismiss button + auto-dismiss timer) and the history
 * rail panel (`mode="history"`: read-only with a timestamp).
 *
 * The outer border/colour is derived from `notification.severity`
 * (info=blue, warning=amber, error=red) and the per-kind body is delegated:
 * tool-loop → `LoopBody`; run/quality → inline bodies here.
 */
import { useEffect } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  RotateCcw,
  ShieldAlert,
  X as XIcon,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import { LoopBody } from './loop-rows.js';
import {
  dismissNotification,
  type NotificationSeverity,
  type SessionNotification,
} from './session-notifications-store.js';

interface NotificationRowProps {
  sessionId: number;
  notification: SessionNotification;
  mode: 'banner' | 'history';
}

const SEVERITY_CLASS: Record<NotificationSeverity, string> = {
  info: 'border-blue-500/40 bg-blue-500/[0.06] text-blue-700 dark:text-blue-300',
  warning: 'border-amber-500/40 bg-amber-500/[0.06] text-amber-700 dark:text-amber-300',
  error: 'border-destructive/40 bg-destructive/[0.06] text-destructive',
};

function iconFor(n: SessionNotification): LucideIcon {
  switch (n.payload.kind) {
    case 'quality-alert':
      return ShieldAlert;
    case 'run-done':
      return n.severity === 'error' ? AlertTriangle : CheckCircle2;
    case 'run-error':
      return AlertTriangle;
    default: // tool-loop
      return n.severity === 'info' ? RotateCcw : AlertTriangle;
  }
}

export function NotificationRow({ sessionId, notification, mode }: NotificationRowProps) {
  const { autoDismissMs, id } = notification;

  // Auto-dismiss the active banner after its severity budget. History rows
  // never expire. Mirrors the `ToastView` setTimeout pattern.
  useEffect(() => {
    if (mode !== 'banner' || autoDismissMs == null) return;
    const t = setTimeout(() => dismissNotification(sessionId, id), autoDismissMs);
    return () => clearTimeout(t);
  }, [mode, autoDismissMs, sessionId, id]);

  const Icon = iconFor(notification);
  return (
    <div
      className={cn(
        'rounded-md border px-2.5 py-1.5 text-xs',
        SEVERITY_CLASS[notification.severity],
      )}
    >
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <NotificationBody notification={notification} />
        </div>
        {mode === 'history' ? (
          <span className="mt-0.5 shrink-0 text-[10px] opacity-50 tabular-nums">
            {new Date(notification.receivedAt).toLocaleTimeString()}
          </span>
        ) : (
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={() => dismissNotification(sessionId, id)}
            className="mt-0.5 shrink-0 rounded p-0.5 opacity-50 transition-opacity hover:opacity-100"
          >
            <XIcon className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  );
}

function NotificationBody({ notification }: { notification: SessionNotification }) {
  const p = notification.payload;
  switch (p.kind) {
    case 'tool-loop':
      return <LoopBody intervention={p.intervention} />;
    case 'run-error':
      return (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-semibold">Run error</span>
            <span className="ml-auto text-[10px] uppercase opacity-70">error</span>
          </div>
          <p className="mt-1 rounded bg-background/60 p-1.5 font-mono text-[10px] leading-snug">
            {p.message}
          </p>
        </>
      );
    case 'run-done':
      return (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-semibold">Session finished</span>
            <span className="text-[10px] opacity-70">{p.reason}</span>
            <span className="ml-auto text-[10px] uppercase opacity-70">
              {p.error ? 'error' : 'done'}
            </span>
          </div>
          {p.error && (
            <p className="mt-1 rounded bg-background/60 p-1.5 font-mono text-[10px] leading-snug">
              {p.error}
            </p>
          )}
        </>
      );
    case 'quality-alert':
      return (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-semibold">Quality watchdog</span>
            <span className="text-[10px] opacity-70">turn {p.turn}</span>
            <span className="ml-auto text-[10px] uppercase opacity-70">{p.verdict}</span>
          </div>
          <p className="mt-0.5 leading-snug">
            {p.suspectTool && <span className="font-mono">{p.suspectTool}</span>} {p.reason}
          </p>
        </>
      );
  }
}
