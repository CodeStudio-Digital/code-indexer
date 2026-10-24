/**
 * Shared bottom status-bar shell — 22px tall, hairline top border,
 * translucent card surface, 10px muted text. Both the ProjectView
 * `StatusBar` and the Company session's `CompanyStatusBar` render their
 * chips inside this so the footer reads identically across modes.
 */
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils.js';

interface StatusBarShellProps {
  children: ReactNode;
  className?: string;
}

export function StatusBarShell({ children, className }: StatusBarShellProps) {
  return (
    <footer
      className={cn(
        'h-[22px] shrink-0 border-t border-[var(--workbench-border)] bg-[var(--workbench-raised)] flex items-center px-2 gap-3 text-[10px] text-muted-foreground select-none',
        className,
      )}
    >
      {children}
    </footer>
  );
}
