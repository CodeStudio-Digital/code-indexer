/**
 * InspectorSection — a collapsible, persisted section for the right inspector,
 * mirroring the chat "Estado da sessão" sidebar so the studio reads as the same
 * system. Each card wraps its body in one of these: the header carries the
 * chevron + icon + uppercase title (the card's old header style) plus an
 * optional `actions` slot, and open/closed state is remembered per section id
 * in localStorage (`sprite-studio:inspector:{id}`) — global, not per project,
 * since a collapse preference is naturally the same everywhere.
 */
import { useCallback, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../../lib/utils.js';

interface InspectorSectionProps {
  /** Stable id — the localStorage key suffix. */
  id: string;
  title: string;
  icon: LucideIcon;
  /** Right-aligned header controls (refresh, lock…). Clicks never toggle. */
  actions?: ReactNode;
  defaultOpen?: boolean;
  /** Body layout class (matches each card's old spacing). */
  bodyClassName?: string;
  /** Skip the default body padding — the section owns its full-width layout
   *  (used by the versions list so its scroll + pinned preview reach the edge). */
  flushBody?: boolean;
  children: ReactNode;
}

export function InspectorSection({
  id,
  title,
  icon: Icon,
  actions,
  defaultOpen = true,
  bodyClassName = 'space-y-2',
  flushBody = false,
  children,
}: InspectorSectionProps) {
  const storageKey = `sprite-studio:inspector:${id}`;
  const [open, setOpen] = useState<boolean>(() => readOpen(storageKey, defaultOpen));

  const toggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(storageKey, next ? '1' : '0');
      } catch {
        /* quota / unavailable */
      }
      return next;
    });
  }, [storageKey]);

  // Edge-to-edge: a bottom divider instead of a boxed border — compact, no
  // lateral padding around the section itself (mirrors the chat sidebar).
  return (
    <section className="border-b border-border/60 last:border-b-0">
      <div className="flex items-center gap-1 px-2 py-1.5">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
        >
          <span className="shrink-0">
            {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </span>
          <Icon className="h-3 w-3 shrink-0" />
          <span className="min-w-0 truncate text-left">{title}</span>
        </button>
        {actions && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
      </div>
      {/* Keep the body MOUNTED and just toggle visibility (like the chat sidebar)
          so scroll position + the versions virtualizer survive collapse — an
          unmounted scroll element would re-measure to zero rows on re-open. */}
      <div className={cn(open ? 'block' : 'hidden', flushBody ? 'pb-1' : cn('px-2 pb-2', bodyClassName))}>
        {children}
      </div>
    </section>
  );
}

function readOpen(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    if (v === '1') return true;
    if (v === '0') return false;
  } catch {
    /* ignore */
  }
  return fallback;
}
