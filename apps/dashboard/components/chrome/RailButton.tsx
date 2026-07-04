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
          'relative h-8 w-8 grid place-items-center rounded-md transition-colors disabled:opacity-40',
          active
            ? 'bg-accent text-accent-foreground'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        )}
      >
        <Icon className="h-4 w-4" />
        {active && (
          <span
            aria-hidden
            className={cn(
              'absolute top-1.5 bottom-1.5 w-0.5 rounded-full bg-primary',
              side === 'right' ? '-right-1' : '-left-1',
            )}
          />
        )}
      </button>
      {Menu}
    </>
  );
});
