/**
 * Icon-only button whose label slides in on hover/focus — the same animation
 * as AppShell's NavButton and the api-client SidebarAction, factored out so
 * dense toolbars (git section headers, etc.) can stay tight but discoverable.
 * The label doubles as the accessible name (aria-label + title).
 */
import { cn } from '../../lib/utils.js';

interface HoverLabelButtonProps {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  tone?: 'default' | 'destructive';
  className?: string;
}

export function HoverLabelButton({ icon: Icon, label, onClick, tone = 'default', className }: HoverLabelButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        'group/hlb inline-flex items-center h-5 rounded px-1 text-[10px] font-medium transition-colors',
        tone === 'destructive'
          ? 'text-muted-foreground hover:bg-destructive/10 hover:text-destructive'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        className,
      )}
    >
      <Icon className="h-3 w-3 shrink-0" />
      <span
        className={cn(
          'overflow-hidden whitespace-nowrap transition-all duration-150 ease-out',
          'ml-0 max-w-0 opacity-0',
          'group-hover/hlb:ml-1 group-hover/hlb:max-w-[160px] group-hover/hlb:opacity-100',
          'group-focus-visible/hlb:ml-1 group-focus-visible/hlb:max-w-[160px] group-focus-visible/hlb:opacity-100',
        )}
      >
        {label}
      </span>
    </button>
  );
}
