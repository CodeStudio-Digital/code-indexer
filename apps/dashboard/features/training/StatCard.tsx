/**
 * StatCard — compact metric tile (label + value), mirroring the telemetry
 * dashboard's stat style. Used for the dataset summary row.
 */
import type { ReactNode } from 'react';

export function StatCard({
  label, value, intent, icon,
}: {
  label: string;
  value: string;
  intent?: 'good' | 'warn' | 'bad';
  icon?: ReactNode;
}) {
  const valueClass =
    intent === 'good' ? 'text-emerald-600 dark:text-emerald-400'
    : intent === 'warn' ? 'text-amber-600 dark:text-amber-400'
    : intent === 'bad' ? 'text-destructive'
    : '';
  return (
    <div className="rounded-lg border bg-card/50 p-3 flex flex-col gap-0.5">
      <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1">{icon}{label}</span>
      <span className={`text-lg font-semibold tabular-nums ${valueClass}`}>{value}</span>
    </div>
  );
}
