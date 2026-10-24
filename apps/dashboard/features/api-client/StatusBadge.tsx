/**
 * StatusBadge — an HTTP status code chip colored by class (2xx green, 3xx
 * blue, 4xx amber, 5xx/transport-error red). `null` renders as a red "ERR"
 * (the send never got a response). Shared by the response pane + timeline.
 */
import { cn } from '../../lib/utils.js';

function statusClass(s: number | null): string {
  if (s == null) return 'text-red-500 bg-red-500/10';
  if (s < 300) return 'text-emerald-500 bg-emerald-500/10';
  if (s < 400) return 'text-blue-500 bg-blue-500/10';
  if (s < 500) return 'text-amber-500 bg-amber-500/10';
  return 'text-red-500 bg-red-500/10';
}

export function StatusBadge({ status }: { status: number | null }) {
  return (
    <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold tabular-nums shrink-0', statusClass(status))}>
      {status ?? 'ERR'}
    </span>
  );
}
