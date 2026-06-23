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
 * The component uses a 1s `setInterval` to force re-render — cheap, and
 * only runs while streaming, so an idle session pays nothing.
 */
import { useEffect, useState } from 'react';
import { AlertCircle, ScrollText } from 'lucide-react';

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

export function StuckBanner({
  streaming,
  lastEventAt,
  thresholdMs = 30_000,
  onOpenLog,
}: StuckBannerProps) {
  // Force re-render every second while streaming so the elapsed-seconds
  // counter ticks. We only schedule the interval when we're actually
  // streaming — an idle session burns nothing.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!streaming) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [streaming]);

  if (!streaming || !lastEventAt) return null;
  const elapsed = Date.now() - lastEventAt;
  if (elapsed < thresholdMs) return null;

  const seconds = Math.floor(elapsed / 1000);
  return (
    <div className="border-b border-amber-500/40 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
      <div className="flex items-center gap-2">
        <AlertCircle className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1">
          Worker idle for{' '}
          <span className="font-mono font-semibold">{seconds}s</span> — possible
          stall. The runner hasn't emitted any event since the last activity.
        </span>
        {onOpenLog && (
          <button
            type="button"
            onClick={onOpenLog}
            className="inline-flex items-center gap-1 rounded border border-amber-500/40 px-2 py-0.5 text-[10px] font-medium hover:bg-amber-500/[0.12]"
          >
            <ScrollText className="h-3 w-3" />
            Open log
          </button>
        )}
      </div>
    </div>
  );
}
