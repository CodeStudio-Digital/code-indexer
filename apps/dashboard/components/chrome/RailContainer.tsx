/**
 * Shared vertical activity-rail shell — 40px wide, translucent card
 * surface, a hairline divider on its inner edge. Used by ProjectView's
 * `ProjectRail` and the Company session's left/right rails so all three
 * read as the same component. `mt-auto` on a child still pins a footer
 * group to the bottom (the flex column is preserved).
 */
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils.js';

export interface RailContainerProps {
  /** Which side of the content the rail sits on — drives the border edge. */
  side: 'left' | 'right';
  children: ReactNode;
  'aria-label'?: string;
}

export function RailContainer({ side, children, 'aria-label': ariaLabel }: RailContainerProps) {
  return (
    <nav
      aria-label={ariaLabel}
      className={cn(
        'flex flex-col w-10 shrink-0 items-center gap-0.5 overflow-x-hidden overflow-y-auto bg-[var(--workbench-raised)] py-1',
        side === 'left'
          ? 'border-r border-[var(--workbench-border)]'
          : 'border-l border-[var(--workbench-border)]',
      )}
    >
      {children}
    </nav>
  );
}
