/**
 * Standardised chrome for every right-panel — a thin header with an
 * icon, title, optional extra actions, and a close (X) button. The body
 * is a flex column that scrolls independently of the header.
 *
 * Lives inside `RightPanelHost`, which decides which body to render
 * based on the active panel id. Each panel component (e.g.
 * `SkillConfigPanel`) renders `<PanelChrome>` once and passes its body
 * as children.
 */
import { X, type LucideIcon } from 'lucide-react';
import { cn } from '../../../lib/utils.js';

export interface PanelChromeProps {
  title: string;
  icon: LucideIcon;
  /** Right-aligned action slots (header buttons). Optional. */
  actions?: React.ReactNode;
  /** Close handler — wired to the rail's "deactivate" action. */
  onClose: () => void;
  /** Extra classes applied to the scrollable body container. */
  bodyClassName?: string;
  children: React.ReactNode;
}

export function PanelChrome({
  title,
  icon: Icon,
  actions,
  onClose,
  bodyClassName,
  children,
}: PanelChromeProps) {
  return (
    <div className="flex flex-col h-full min-h-0 bg-card">
      <header className="flex items-center gap-2 px-3 h-9 border-b shrink-0">
        <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className="text-xs font-semibold truncate flex-1">{title}</span>
        {actions}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close panel"
          className="p-1 -mr-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>
      <div className={cn('flex-1 min-h-0 overflow-auto', bodyClassName)}>{children}</div>
    </div>
  );
}
