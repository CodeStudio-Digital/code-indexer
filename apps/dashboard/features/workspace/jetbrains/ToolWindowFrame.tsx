/**
 * Common chrome around a tool window: title bar + optional toolbar
 * actions + body. Body fills the remainder. Keeps every tool window
 * visually consistent without each one re-implementing the same header.
 */

import { cn } from '../../../lib/utils.js';
import { WorkbenchPanelHeader } from '../../../components/workbench/index.js';

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
    <div className={cn('h-full flex flex-col bg-[var(--workbench-surface)] min-h-0', className)}>
      <WorkbenchPanelHeader title={title} actions={actions} onClose={onClose} />
      <div className="flex-1 min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}
