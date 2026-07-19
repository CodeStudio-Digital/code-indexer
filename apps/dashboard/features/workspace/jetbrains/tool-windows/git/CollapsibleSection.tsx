/**
 * Collapsible list section with a sticky, chevron-toggled header — the
 * shared building block behind the Git panel's grouped lists (Changes:
 * staged / unstaged / untracked; Branches: local / remote). The header
 * stays pinned while the body scrolls; `actions` renders right-aligned
 * controls (bulk stage/discard, etc.).
 */
import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '../../../../../lib/utils.js';

interface CollapsibleSectionHeaderProps {
  title: string;
  open: boolean;
  onToggle: () => void;
  /** Additional visual treatment for a specific section family. */
  className?: string;
  /** Optional semantic color for the section label. */
  titleClassName?: string;
  /** Optional control placed between the disclosure arrow and the title. */
  headerControl?: ReactNode;
  /** Right-aligned controls (e.g. bulk actions). */
  actions?: ReactNode;
  /** Virtualized rows cannot use CSS sticky positioning. */
  sticky?: boolean;
}

interface CollapsibleSectionProps extends CollapsibleSectionHeaderProps {
  children: ReactNode;
}

export function CollapsibleSectionHeader({
  title,
  open,
  onToggle,
  className,
  titleClassName,
  headerControl,
  actions,
  sticky = true,
}: CollapsibleSectionHeaderProps) {
  return (
    <div className={cn(
      'z-[1] flex items-center gap-1 px-2.5 py-1 bg-card/80 backdrop-blur supports-[backdrop-filter]:bg-card/60 border-b',
      sticky && 'sticky top-0',
      className,
    )}>
      <button
        type="button"
        onClick={onToggle}
        aria-label={title}
        aria-expanded={open}
        className="grid h-4 w-3 shrink-0 place-items-center text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
      </button>
      {headerControl}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={cn(
          'min-w-0 truncate text-left text-[10px] uppercase tracking-[0.08em] text-muted-foreground hover:text-foreground',
          titleClassName,
        )}
      >
        <span className="block truncate font-semibold">{title}</span>
      </button>
      {actions && <div className="ml-auto">{actions}</div>}
    </div>
  );
}

export function CollapsibleSection({
  title,
  open,
  onToggle,
  className,
  titleClassName,
  headerControl,
  actions,
  sticky,
  children,
}: CollapsibleSectionProps) {
  return (
    <div>
      <CollapsibleSectionHeader
        title={title}
        open={open}
        onToggle={onToggle}
        className={className}
        titleClassName={titleClassName}
        headerControl={headerControl}
        actions={actions}
        sticky={sticky}
      />
      {open && children}
    </div>
  );
}
