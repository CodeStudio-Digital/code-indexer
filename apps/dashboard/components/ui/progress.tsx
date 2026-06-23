import * as React from 'react';
import { cn } from '../../lib/utils.js';

interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: number;
  max?: number;
  indeterminate?: boolean;
}

/**
 * Minimal shadcn-style progress bar. We don't depend on
 * `@radix-ui/react-progress` to keep the bundle lean — a plain div with
 * aria attributes is enough for the index-progress use case.
 */
export const Progress = React.forwardRef<HTMLDivElement, ProgressProps>(
  ({ className, value, max = 100, indeterminate, ...props }, ref) => {
    const pct =
      indeterminate || value == null
        ? null
        : Math.max(0, Math.min(100, (value / max) * 100));

    return (
      <div
        ref={ref}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={pct ?? undefined}
        className={cn(
          'relative h-2 w-full overflow-hidden rounded-full bg-muted',
          className,
        )}
        {...props}
      >
        {indeterminate ? (
          <div className="absolute inset-y-0 left-0 w-1/3 animate-[progress-indeterminate_1.2s_ease-in-out_infinite] rounded-full bg-primary" />
        ) : (
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-200 ease-out"
            style={{ width: `${pct ?? 0}%` }}
          />
        )}
      </div>
    );
  },
);
Progress.displayName = 'Progress';
