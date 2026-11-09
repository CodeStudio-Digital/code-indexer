/**
 * Banner that surfaces when a streaming run has stopped emitting events.
 *
 * Heuristic: `streaming === true` AND no SSE event was observed for
 * `thresholdMs` (default 30s). When the threshold trips, render a yellow
 * strip with a live-ticking "Worker idle for Xs" counter and a CTA to
 * open the Worker Log panel for diagnostics.
 *
 * Why a separate component instead of folding into the log panel itself:
 * the user might have the panel closed (collapsed) — in that case the
 * banner above MessageList is the only signal that the session is stuck
 * rather than legitimately slow. Closing the panel doesn't hide the
 * alert.
 *
 * The counter ticks off the app-wide shared clock (`lib/perf/shared-clock`),
 * subscribed only while streaming — an idle session pays nothing and a hidden
 * window stops ticking entirely.
 */
import { memo } from 'react';
import { AlertCircle, ScrollText } from 'lucide-react';
import { useNow } from '../../lib/perf/shared-clock.js';
import { useTranslation } from 'react-i18next';

interface StuckBannerProps {
  /** When false, the banner never renders (no stream → no stall to flag). */
  streaming: boolean;
  /** `Date.now()` of last SSE event. Null = no event yet → no stall (we're still booting). */
  lastEventAt: number | null;
  /** How many ms of silence trigger the banner. Default 30 000. */
  thresholdMs?: number;
  /** Optional CTA — when provided, an "Open log" button surfaces beside the message. */
  onOpenLog?: () => void;
}

export const StuckBanner = memo(function StuckBanner({
  streaming,
  lastEventAt,
  thresholdMs = 30_000,
  onOpenLog,
}: StuckBannerProps) {
  const { t } = useTranslation('chat');
  // Re-render every second while streaming so the elapsed-seconds counter
  // ticks. Subscribing to the app-wide 1 Hz clock only while `streaming` keeps
  // an idle session at zero timers, and a hidden window at zero wakeups.
  const now = useNow(streaming);

  if (!streaming || !lastEventAt) return null;
  const elapsed = now - lastEventAt;
  if (elapsed < thresholdMs) return null;

  const seconds = Math.floor(elapsed / 1000);
  return (
    <div className="border-b border-amber-500/40 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
      <div className="flex items-center gap-2">
        <AlertCircle className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1">
          {t('connectionSilent', { seconds })}
        </span>
        {onOpenLog && (
          <button
            type="button"
            onClick={onOpenLog}
            className="inline-flex items-center gap-1 rounded border border-amber-500/40 px-2 py-0.5 text-[10px] font-medium hover:bg-amber-500/[0.12]"
          >
            <ScrollText className="h-3 w-3" />
            {t('connectionOpenLog')}
          </button>
        )}
      </div>
    </div>
  );
});
