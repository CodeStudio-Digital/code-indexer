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
  /** Right-aligned controls (e.g. bulk actions). */
  actions?: ReactNode;
  children: ReactNode;
}

export function CollapsibleSection({ title, open, onToggle, actions, children }: CollapsibleSectionProps) {
  return (
    <div>
      <div className="sticky top-0 z-[1] flex items-center gap-1 px-2.5 py-1 bg-card/80 backdrop-blur supports-[backdrop-filter]:bg-card/60 border-b">
        <button
          type="button"
          onClick={onToggle}
          className="flex items-center gap-1 text-[10px] uppercase tracking-[0.08em] text-muted-foreground hover:text-foreground"
        >
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          <span className="font-semibold">{title}</span>
        </button>
        {actions && <div className="ml-auto">{actions}</div>}
      </div>
      {open && children}
    </div>
  );
}
