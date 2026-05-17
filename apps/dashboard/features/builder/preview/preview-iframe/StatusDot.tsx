import React from 'react';

export function StatusDot({ status }: { status: string | null }) {
  const color =
    status === 'ready'
      ? 'bg-emerald-500'
      : status === 'error'
        ? 'bg-red-500'
        : status === 'paused'
          ? 'bg-slate-400'
          : status === null
            ? 'bg-muted'
            : 'bg-amber-500 animate-pulse';
  return <span className={`inline-block h-2 w-2 rounded-full ${color}`} aria-label={status ?? 'idle'} />;
}
