/**
 * Banner that surfaces "Master finished" and "Master ended unexpectedly"
 * states from the company stream. Renders inline above `ZoneLayout` in
 * `CompanySessionView`.
 *
 * Three variants:
 *   - `error`: red persistent banner with `errorDetail`. Shown whenever
 *     `masterErrorDetail` is set (independent of `masterEndedAt`).
 *   - `unexpected`: orange persistent banner. Master exited without a
 *     recent user message (e.g. internal abort, runner crash). Stays
 *     visible until the user sends a new message.
 *   - `finished`: blue auto-dismiss toast for the "happy path" exit
 *     after a user turn. Fades after 10s via local timer.
 *
 * The banner reads timestamps from the `useCompanyStream` selectors so
 * a tab switch that re-mounts the view also re-renders the latest
 * state from the slice (SSE replay covers reloads).
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, CheckCircle2, X } from 'lucide-react';
import { cn } from '../../lib/utils.js';

interface MasterStatusBannerProps {
  /** ISO timestamp of the last runner exit, null when active or never started. */
  endedAt: string | null;
  /** True when the exit looked unexpected (errored or no recent user turn). */
  unexpected: boolean;
  /** Error detail string when the master ended with an error. */
  errorDetail: string | null;
}

const FINISHED_AUTO_DISMISS_MS = 10_000;

export function MasterStatusBanner({ endedAt, unexpected, errorDetail }: MasterStatusBannerProps) {
  const { t } = useTranslation('agents');
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [autoHidden, setAutoHidden] = useState(false);

  // Reset auto-hide whenever a NEW endedAt arrives. Same timestamp =
  // same banner (probably a re-render); skip the timer in that case so
  // the banner doesn't keep restarting.
  useEffect(() => {
    setAutoHidden(false);
    if (!endedAt) return;
    if (unexpected || errorDetail) return; // only auto-hide the happy variant
    const handle = setTimeout(() => setAutoHidden(true), FINISHED_AUTO_DISMISS_MS);
    return () => clearTimeout(handle);
  }, [endedAt, unexpected, errorDetail]);

  if (!endedAt) return null;
  if (dismissed === endedAt) return null;
  if (autoHidden && !unexpected && !errorDetail) return null;

  const isError = !!errorDetail;
  const isUnexpected = unexpected && !isError;
  const variant = isError ? 'error' : isUnexpected ? 'unexpected' : 'finished';

  const Icon = variant === 'finished' ? CheckCircle2 : AlertCircle;
  const time = formatTime(endedAt);

  const titleKey =
    variant === 'error'
      ? 'masterBanner.errorTitle'
      : variant === 'unexpected'
        ? 'masterBanner.unexpectedTitle'
        : 'masterBanner.finishedTitle';
  const titleFallback =
    variant === 'error'
      ? 'Master ended with error'
      : variant === 'unexpected'
        ? 'Master ended unexpectedly'
        : 'Master finished';

  const detail =
    variant === 'error'
      ? errorDetail
      : variant === 'unexpected'
        ? t('masterBanner.unexpectedHint', 'Send a message to resume.')
        : t('masterBanner.finishedHint', 'Send a follow-up to start a new turn.');

  return (
    <div
      className={cn(
        'mx-3 mt-3 p-3 rounded-lg border text-xs flex items-start gap-2',
        variant === 'error' && 'border-destructive/30 bg-destructive/5 text-destructive',
        variant === 'unexpected' && 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
        variant === 'finished' && 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
      )}
      role={variant === 'error' ? 'alert' : 'status'}
    >
      <Icon className="h-4 w-4 shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <div className="font-medium">
          {t(titleKey, titleFallback)}
          <span className="ml-2 opacity-70 font-normal">{time}</span>
        </div>
        {detail && <div className="mt-0.5 opacity-90 break-words">{detail}</div>}
      </div>
      <button
        type="button"
        onClick={() => setDismissed(endedAt)}
        className="p-0.5 rounded hover:bg-foreground/10 transition-colors shrink-0"
        aria-label={t('common.close', 'Close')}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString();
  } catch {
    return '';
  }
}
