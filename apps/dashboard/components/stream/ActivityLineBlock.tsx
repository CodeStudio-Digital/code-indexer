import { useEffect, useState } from 'react';
import { Activity, Check, Clock, Loader2, X } from 'lucide-react';
import type { StreamActivityBlock } from '../../hooks/agent-stream/types.js';
import { cn } from '../../lib/utils.js';

interface ActivityLineBlockProps {
  activity: StreamActivityBlock;
}

export function ActivityLineBlock({ activity }: ActivityLineBlockProps) {
  const running = activity.status === 'running';
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [running, activity.startedAt]);

  const Icon = iconForStatus(activity.status);
  const elapsed = running
    ? Math.max(0, Date.now() - activity.startedAt)
    : activity.elapsedMs;
  const phase = activity.phase ? readable(activity.phase) : readable(activity.kind);
  const remaining =
    running && activity.deadlineMs != null && elapsed != null
      ? Math.max(0, activity.deadlineMs - elapsed)
      : null;

  return (
    <div
      className={cn(
        'my-1 flex min-w-0 items-center gap-2 rounded-md border px-2 py-1 text-[11px]',
        activity.status === 'running'
          ? 'border-warning/25 bg-warning/[0.05] text-warning-foreground'
          : activity.status === 'completed'
            ? 'border-success/25 bg-success/[0.05] text-success'
            : 'border-destructive/25 bg-destructive/[0.05] text-destructive',
      )}
    >
      <Icon className={cn('h-3.5 w-3.5 shrink-0', running && 'animate-spin')} />
      <span className="min-w-0 truncate font-mono font-medium">{activity.label}</span>
      <span className="shrink-0 text-muted-foreground">{phase}</span>
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
}

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
