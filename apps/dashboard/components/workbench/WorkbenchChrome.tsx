import type { ReactNode } from 'react';
import { X, type LucideIcon } from 'lucide-react';
import { PanelResizeHandle } from 'react-resizable-panels';
import { cn } from '../../lib/utils.js';

export function WorkbenchShell({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('workbench-shell flex h-full min-h-0 flex-col', className)}>{children}</div>;
}

export function WorkbenchSurface({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cn('workbench-surface min-h-0 overflow-hidden', className)}>{children}</section>;
}

export interface WorkbenchPageHeaderProps {
  title: string;
  description?: ReactNode;
  icon?: LucideIcon;
  actions?: ReactNode;
  className?: string;
}

/** Compact title band shared by full-height, non-project workbench pages. */
export function WorkbenchPageHeader({
  title,
  description,
  icon: Icon,
  actions,
  className,
}: WorkbenchPageHeaderProps) {
  return (
    <header
      className={cn(
        'flex h-9 shrink-0 items-center gap-2 border-b border-[var(--workbench-border)] bg-[var(--workbench-raised)] px-3',
        className,
      )}
    >
      {Icon && (
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded bg-[var(--workbench-active)] text-violet-400">
          <Icon className="h-3.5 w-3.5" />
        </span>
      )}
      <span className="shrink-0 text-xs font-semibold">{title}</span>
      {description && (
        <span className="hidden min-w-0 truncate text-[11px] text-muted-foreground md:block">
          {description}
        </span>
      )}
      {actions && <div className="ml-auto flex min-w-0 items-center gap-1.5">{actions}</div>}
    </header>
  );
}

/** One-row command/filter band. It intentionally has no rounded card chrome. */
export function WorkbenchToolbar({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'flex min-h-9 shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--workbench-border)] bg-[var(--workbench-raised)] px-2 py-1',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function WorkbenchResizeHandle({
  direction,
  disabled = false,
  className,
}: {
  direction: 'horizontal' | 'vertical';
  disabled?: boolean;
  className?: string;
}) {
  return (
    <PanelResizeHandle
      disabled={disabled}
      className={cn(
        'workbench-resize-handle shrink-0',
        direction === 'horizontal' ? 'w-1.5 cursor-col-resize' : 'h-1.5 cursor-row-resize',
        className,
      )}
    />
  );
}

export interface WorkbenchPanelHeaderProps {
  title: string;
  icon?: LucideIcon;
  actions?: ReactNode;
  onClose?: () => void;
  closeLabel?: string;
  className?: string;
}

export function WorkbenchPanelHeader({
  title,
  icon: Icon,
  actions,
  onClose,
  closeLabel = `Close ${title}`,
  className,
}: WorkbenchPanelHeaderProps) {
  return (
    <header className={cn('workbench-panel-header', className)}>
      {Icon && <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />}
      <span className="min-w-0 flex-1 truncate text-[11px] font-semibold">{title}</span>
      {actions}
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label={closeLabel}
          className="grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-[var(--workbench-hover)] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </header>
  );
}

export function WorkbenchTabStrip({
  children,
  className,
  'aria-label': ariaLabel,
}: {
  children: ReactNode;
  className?: string;
  'aria-label'?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        'flex h-8 shrink-0 items-stretch overflow-x-auto border-b border-[var(--workbench-border)] bg-[var(--workbench-surface)]',
        className,
      )}
    >
      {children}
    </div>
  );
}
