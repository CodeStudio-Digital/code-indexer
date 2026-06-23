/**
 * Common chrome around a tool window: title bar + optional toolbar
 * actions + body. Body fills the remainder. Keeps every tool window
 * visually consistent without each one re-implementing the same header.
 */

import { X } from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import { Button } from '../../../components/ui/button.js';

interface ToolWindowFrameProps {
  title: string;
  /** Right-aligned action icons (e.g. refresh, new file). */
  actions?: React.ReactNode;
  onClose?: () => void;
  className?: string;
  children: React.ReactNode;
}

export function ToolWindowFrame({
  title,
  actions,
  onClose,
  className,
  children,
}: ToolWindowFrameProps) {
  return (
    <div className={cn('h-full flex flex-col bg-card/20 min-h-0', className)}>
      <div className="h-7 shrink-0 border-b flex items-center px-2 gap-1 bg-card/40">
        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.08em] flex-1 truncate">
          {title}
        </span>
        {actions}
        {onClose && (
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5 text-muted-foreground hover:text-foreground"
            onClick={onClose}
            aria-label={`Close ${title}`}
          >
            <X className="h-3 w-3" />
          </Button>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}
