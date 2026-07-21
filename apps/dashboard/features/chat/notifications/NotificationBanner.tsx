/**
 * Active-notification strip above the message list. Shows every notification
 * that hasn't been dismissed (manually via the X, or automatically after its
 * severity budget). The full history lives in the Notifications rail panel.
 *
 * Replaces the old always-on `ToolLoopBanner` — same container styling, but
 * now dismissable + auto-dismissing and fed by the session notification store.
 */
import { memo } from 'react';
import { NotificationRow } from './NotificationRow.js';
import { useSessionNotifications } from './session-notifications-store.js';

interface NotificationBannerProps {
  sessionId: number;
}

export const NotificationBanner = memo(function NotificationBanner({ sessionId }: NotificationBannerProps) {
  const all = useSessionNotifications(sessionId);
  const active = all.filter((n) => !n.dismissed);
  if (active.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 border-b border-border/60 bg-muted/30 px-3 py-2">
      {active.map((n) => (
        <NotificationRow key={n.id} sessionId={sessionId} notification={n} mode="banner" />
      ))}
    </div>
  );
});
