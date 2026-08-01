import { memo } from 'react';
import { Activity, Check, Clock, Loader2, X } from 'lucide-react';
import type { StreamActivityBlock } from '../../hooks/agent-stream/types.js';
import { useNow } from '../../lib/perf/shared-clock.js';
import { cn } from '../../lib/utils.js';

interface ActivityLineBlockProps {
  activity: StreamActivityBlock;
}

/**
 * Memoized: a live turn can hold many activity lines and re-renders on every
 * rAF flush. Only the block whose `activity` object actually changed this frame
 * reconciles; the elapsed label advances through the shared 1 Hz clock, which
 * costs one timer for the whole app instead of one per running line.
 */
export const ActivityLineBlock = memo(function ActivityLineBlock({ activity }: ActivityLineBlockProps) {
  const running = activity.status === 'running';
  const now = useNow(running);

  const Icon = iconForStatus(activity.status);
  const elapsed = running
    ? Math.max(0, now - activity.startedAt)
    : activity.elapsedMs;
  const phase = activity.phase ? readable(activity.phase) : readable(activity.kind);
  const remaining =
    running && activity.deadlineMs != null && elapsed != null
      ? Math.max(0, activity.deadlineMs - elapsed)
      : null;

  return (
    <div
      className={cn(
        'group/activity my-1 flex min-w-0 items-center gap-1.5 py-1 text-[11px]',
        activity.status === 'running'
          ? 'text-muted-foreground'
          : activity.status === 'completed'
            ? 'text-muted-foreground'
            : 'text-destructive',
      )}
    >
      <Icon className={cn('h-3 w-3 shrink-0', running && 'animate-spin')} />
      <span className="min-w-0 truncate font-medium">{activity.label}</span>
      <span className="hidden shrink-0 text-muted-foreground/60 group-hover/activity:inline">{phase}</span>
      {activity.note && (
        <span className="min-w-0 truncate text-muted-foreground">{activity.note}</span>
      )}
      {elapsed != null && (
        <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
          {running ? 'running ' : ''}{formatMs(elapsed)}
        </span>
      )}
      {remaining != null && (
        <span className="shrink-0 tabular-nums text-muted-foreground">
          left {formatMs(remaining)}
        </span>
      )}
    </div>
  );
});

function iconForStatus(status: StreamActivityBlock['status']) {
  if (status === 'running') return Loader2;
  if (status === 'completed') return Check;
  if (status === 'aborted') return Clock;
  if (status === 'failed' || status === 'timed_out') return X;
  return Activity;
}

function readable(value: string): string {
  return value.replace(/[_:.-]+/g, ' ');
}

function formatMs(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.max(0, Math.floor(ms / 1000))}s`;
}
