/**
 * History view for the Notifications rail entry. Lists every notification
 * raised during the session (newest first) — active and already-dismissed
 * alike — so nothing is lost the way the old capped banner stack lost it.
 *
 * Opening the panel marks everything read (clears the rail badge). A toolbar
 * offers "Dismiss active" (clears the banner strip) and "Clear all" (drops the
 * history). Rendered inside `PanelChrome` by `RightPanelHost`.
 */
import { useEffect, useMemo } from 'react';
import { BellOff } from 'lucide-react';
import { NotificationRow } from './NotificationRow.js';
import {
  clearNotifications,
  dismissAllActive,
  markAllRead,
  useSessionNotifications,
} from './session-notifications-store.js';

interface NotificationsPanelProps {
  sessionId: number;
}

export function NotificationsPanel({ sessionId }: NotificationsPanelProps) {
  const all = useSessionNotifications(sessionId);

  // Reading the panel clears the unread badge.
  useEffect(() => {
    markAllRead(sessionId);
  }, [sessionId, all.length]);

  const newestFirst = useMemo(() => [...all].reverse(), [all]);
  const activeCount = useMemo(() => all.filter((n) => !n.dismissed).length, [all]);

  if (all.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
        <BellOff className="h-6 w-6 opacity-40" />
        <p className="text-xs">No notifications yet</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5 text-[11px] text-muted-foreground">
        <span className="tabular-nums">{all.length} total</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => dismissAllActive(sessionId)}
            disabled={activeCount === 0}
            className="rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
          >
            Dismiss active
          </button>
          <button
            type="button"
            onClick={() => clearNotifications(sessionId)}
            className="rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground"
          >
            Clear all
          </button>
        </div>
      </div>
      <div className="flex flex-col gap-1 overflow-y-auto p-2">
        {newestFirst.map((n) => (
          <NotificationRow key={n.id} sessionId={sessionId} notification={n} mode="history" />
        ))}
      </div>
    </div>
  );
}
