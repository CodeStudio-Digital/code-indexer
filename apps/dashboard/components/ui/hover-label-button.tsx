/**
 * Icon-only button whose label slides in on hover/focus — the same animation
 * as AppShell's NavButton and the api-client SidebarAction, factored out so
 * dense toolbars (git section headers, editor toolbars, etc.) can stay tight
 * but discoverable. The label doubles as the accessible name (aria-label +
 * title). Optional `busy` swaps the icon for a spinner; `disabled` greys it out.
 */
import { Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils.js';

interface HoverLabelButtonProps {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  tone?: 'default' | 'destructive' | 'primary';
  disabled?: boolean;
  /** Swap the icon for a spinner while an action is in flight (also disables). */
  busy?: boolean;
  className?: string;
}

const TONE: Record<NonNullable<HoverLabelButtonProps['tone']>, string> = {
  default: 'text-muted-foreground hover:bg-muted hover:text-foreground',
  destructive: 'text-muted-foreground hover:bg-destructive/10 hover:text-destructive',
  primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
};

export function HoverLabelButton({
  icon: Icon, label, onClick, tone = 'default', disabled, busy, className,
}: HoverLabelButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      aria-label={label}
      title={label}
      className={cn(
        'group/hlb inline-flex items-center h-5 rounded px-1 text-[10px] font-medium transition-colors disabled:opacity-50',
        TONE[tone],
        className,
      )}
    >
      {busy ? <Loader2 className="h-3 w-3 shrink-0 animate-spin" /> : <Icon className="h-3 w-3 shrink-0" />}
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
