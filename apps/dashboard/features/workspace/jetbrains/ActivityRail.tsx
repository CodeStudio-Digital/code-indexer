/**
 * Vertical activity bar — column of icon buttons that toggle tool windows.
 * Used on both the left side (Files / Search / Snapshots / Git) and the
 * right side (Chat / Sessions / Inbox).
 *
 * Click the active icon again to collapse the panel. Hover shows the
 * label; selected state uses a primary-tinted left/right accent bar
 * (depending on side) to mirror JetBrains.
 */

import { cn } from '../../../lib/utils.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip.js';

export interface RailItem<TId extends string> {
  id: TId;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

interface ActivityRailProps<TId extends string> {
  side: 'left' | 'right';
  items: RailItem<TId>[];
  active: TId | null;
  onToggle: (id: TId) => void;
}

export function ActivityRail<TId extends string>({
  side,
  items,
  active,
  onToggle,
}: ActivityRailProps<TId>) {
  return (
    <div
      className={cn(
        'h-full w-10 shrink-0 flex flex-col items-center py-1 gap-0.5 bg-card/40',
        side === 'left' ? 'border-r' : 'border-l',
      )}
      aria-label={`${side === 'left' ? 'Left' : 'Right'} activity bar`}
    >
      {items.map((item) => {
        const isActive = active === item.id;
        const Icon = item.icon;
        return (
          <Tooltip key={item.id}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => onToggle(item.id)}
                aria-label={item.label}
                aria-pressed={isActive}
                className={cn(
                  'group relative h-8 w-8 grid place-items-center rounded-md',
                  'transition-colors',
                  isActive
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted',
                )}
              >
                <Icon className="h-4 w-4" />
                {/* Active accent bar — left edge on left rail, right edge on right rail. */}
                {isActive && (
                  <span
                    aria-hidden
                    className={cn(
                      'absolute top-1.5 bottom-1.5 w-0.5 bg-primary rounded-full',
                      side === 'left' ? '-left-1' : '-right-1',
                    )}
                  />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side={side === 'left' ? 'right' : 'left'}>{item.label}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
