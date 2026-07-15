/**
 * Collapsible list section with a sticky, chevron-toggled header — the
 * shared building block behind the Git panel's grouped lists (Changes:
 * staged / unstaged / untracked; Branches: local / remote). The header
 * stays pinned while the body scrolls; `actions` renders right-aligned
 * controls (bulk stage/discard, etc.).
 */
import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

interface CollapsibleSectionProps {
  title: string;
  open: boolean;
  onToggle: () => void;
  /** Optional control placed between the disclosure arrow and the title. */
  headerControl?: ReactNode;
  /** Right-aligned controls (e.g. bulk actions). */
  actions?: ReactNode;
  children: ReactNode;
}

export function CollapsibleSection({
  title,
  open,
  onToggle,
  headerControl,
  actions,
  children,
}: CollapsibleSectionProps) {
  return (
    <div>
      <div className="sticky top-0 z-[1] flex items-center gap-1 px-2.5 py-1 bg-card/80 backdrop-blur supports-[backdrop-filter]:bg-card/60 border-b">
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
          className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground hover:text-foreground"
        >
          <span className="font-semibold">{title}</span>
        </button>
        {actions && <div className="ml-auto">{actions}</div>}
      </div>
      {open && children}
    </div>
  );
}
