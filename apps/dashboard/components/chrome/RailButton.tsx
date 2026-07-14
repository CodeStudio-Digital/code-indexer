/**
 * Shared activity-rail icon button — the single source of truth for the
 * rail-button look across ProjectView (`ProjectRail`) and the Company
 * session view (`LeftTabRail` / `SidebarRail`): a 32px square, rounded,
 * with an accent tint + a thin selection bar when active.
 *
 * `role` picks the a11y semantics:
 *   - 'tab'    → aria-current="page" (selecting a section / tab)
 *   - 'toggle' → aria-pressed         (toggling a drawer / panel open)
 *
 * `side` anchors the selection bar to the rail's inner edge: left rails
 * place it on the left, the Company right rail places it on the right.
 */
import { memo } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { useContextMenu, type ContextMenuItem } from '../ui/context-menu.js';

export interface RailButtonProps {
  icon: LucideIcon;
  label: string;
  active: boolean;
  onClick: () => void;
  /** Which edge the selection bar hugs. Defaults to 'left'. */
  side?: 'left' | 'right';
  /** A11y semantics: a selectable tab vs a toggle. Defaults to 'tab'. */
  role?: 'tab' | 'toggle';
  disabled?: boolean;
  /** Right-click menu items (e.g. Pin/Unpin). Omit for no menu. */
  contextItems?: ContextMenuItem[];
  /** Optional compact notification counter. */
  badge?: number;
}

export const RailButton = memo(function RailButton({
  icon: Icon,
  label,
  active,
  onClick,
  side = 'left',
  role = 'tab',
  disabled = false,
  contextItems,
  badge,
}: RailButtonProps) {
  const { triggerProps, Menu } = useContextMenu(contextItems ?? []);
  const hasMenu = !!contextItems && contextItems.length > 0;
  return (
    <>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        title={label}
        aria-current={role === 'tab' && active ? 'page' : undefined}
        aria-pressed={role === 'toggle' ? active : undefined}
        {...(hasMenu ? triggerProps : {})}
        className={cn(
          'relative h-8 w-8 grid place-items-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--workbench-focus)] disabled:opacity-40',
          active
            ? 'bg-[var(--workbench-active)] text-foreground'
            : 'text-muted-foreground hover:bg-[var(--workbench-hover)] hover:text-foreground',
        )}
      >
        <Icon className="h-4 w-4" />
        {active && (
          <span
            aria-hidden
            className={cn(
              'absolute top-1.5 bottom-1.5 w-0.5 rounded-full bg-[var(--workbench-focus)]',
              side === 'right' ? '-right-1' : '-left-1',
            )}
          />
        )}
        {badge != null && badge > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-primary px-0.5 text-[8px] font-medium tabular-nums text-primary-foreground">
            {badge > 99 ? '99+' : badge}
          </span>
        )}
      </button>
      {Menu}
    </>
  );
});
