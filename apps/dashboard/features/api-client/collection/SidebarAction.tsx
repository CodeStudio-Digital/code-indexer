/**
 * Compact sidebar action: icon-only by default, the label slides in on hover/
 * focus (same animation as AppShell's NavButton). Used for New request / New
 * folder / Select so the row stays tight but stays discoverable.
 */
import { cn } from '../../../lib/utils.js';

interface Props {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  active?: boolean;
}

export function SidebarAction({ icon: Icon, label, onClick, active }: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        'group/act inline-flex items-center h-7 rounded px-1.5 text-[11px] font-medium transition-colors',
        active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span
        className={cn(
          'overflow-hidden whitespace-nowrap transition-all duration-150 ease-out',
          active
            ? 'ml-1.5 max-w-[120px] opacity-100'
            : 'ml-0 max-w-0 opacity-0 group-hover/act:ml-1.5 group-hover/act:max-w-[120px] group-hover/act:opacity-100 group-focus-visible/act:ml-1.5 group-focus-visible/act:max-w-[120px] group-focus-visible/act:opacity-100',
        )}
      >
        {label}
      </span>
    </button>
  );
}
