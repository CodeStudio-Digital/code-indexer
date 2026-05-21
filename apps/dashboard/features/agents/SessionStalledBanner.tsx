/**
 * Banner that shows when `IdleWatchdog` publishes `session_stalled` —
 * the orchestrator has gone N minutes without any bus activity while
 * the master was still alive. Acts as a manual nudge: the Continue
 * button sends a synthetic system-check message to the master to break
 * the deadlock (typical case: master + all subs blocked waiting for
 * each other).
 *
 * The banner is dismissable. Once dismissed (or once Continue is
 * clicked) it stays hidden until the next `session_stalled` event with
 * a different `stalledSinceMs` value.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Send, X } from 'lucide-react';

interface SessionStalledBannerProps {
  /** Milliseconds since the last bus activity at stall time. `null` = no stall. */
  stalledSinceMs: number | null;
  /** Push a status-check message to the master to break the deadlock. */
  onContinue: () => void;
}

export function SessionStalledBanner({ stalledSinceMs, onContinue }: SessionStalledBannerProps) {
  const { t } = useTranslation('agents');
  const [dismissedFor, setDismissedFor] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  // Re-show whenever the watchdog reports a fresh stall window.
  useEffect(() => {
    setDismissedFor(null);
    setBusy(false);
  }, [stalledSinceMs]);

  if (stalledSinceMs == null) return null;
  if (dismissedFor === stalledSinceMs) return null;

  const minutes = Math.max(1, Math.round(stalledSinceMs / 60_000));

  async function handleContinue() {
    setBusy(true);
    try {
      await onContinue();
      setDismissedFor(stalledSinceMs);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="status"
      className="mx-3 mt-3 p-3 rounded-lg border border-amber-500/40 bg-amber-500/10 text-xs text-amber-700 dark:text-amber-300 flex items-start gap-2"
    >
      <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <div className="font-medium">
          {t('sessionStalled.title', 'Session stalled')}
        </div>
        <div className="mt-0.5 opacity-90">
          {t('sessionStalled.body', '{{minutes}} min without progress. The master may be waiting on a blocked tool or a human reply.', { minutes })}
        </div>
      </div>
      <button
        type="button"
        onClick={handleContinue}
        disabled={busy}
        className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-amber-500/50 hover:bg-amber-500/20 transition-colors disabled:opacity-50 shrink-0"
      >
        <Send className="h-3 w-3" />
        {t('sessionStalled.continue', 'Continue')}
      </button>
      <button
        type="button"
        onClick={() => setDismissedFor(stalledSinceMs)}
        className="p-0.5 rounded hover:bg-foreground/10 transition-colors shrink-0"
        aria-label={t('common.close', 'Close')}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
