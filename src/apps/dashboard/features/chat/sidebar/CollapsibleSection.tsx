import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '../../../lib/utils.js';

interface CollapsibleSectionProps {
  id: string;
  sessionId: number;
  title: string;
  icon?: ReactNode;
  /** Right-aligned header content (badge, count, status pip). */
  headerExtra?: ReactNode;
  /** Sub-line rendered under the title row when expanded. */
  subtitle?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}

/**
 * Collapsible section for the chat right-sidebar. Persists open/closed state
 * in localStorage keyed by session, so each session remembers its own layout.
 */
export function CollapsibleSection({
  id,
  sessionId,
  title,
  icon,
  headerExtra,
  subtitle,
  defaultOpen = true,
  children,
}: CollapsibleSectionProps) {
  const storageKey = `chat:sidebar:${sessionId}:${id}`;
  const [open, setOpen] = useState<boolean>(() => readOpen(storageKey, defaultOpen));

  useEffect(() => {
    setOpen(readOpen(storageKey, defaultOpen));
  }, [storageKey, defaultOpen]);

  const toggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(storageKey, next ? '1' : '0');
      } catch {
        /* ignore quota / unavailable */
      }
      return next;
    });
  }, [storageKey]);

  return (
    <section className="border-b last:border-b-0">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="sticky top-0 z-10 w-full bg-card hover:bg-muted/40 transition-colors px-3 py-2.5 flex items-center gap-2 text-xs font-medium text-left"
      >
        <span className="shrink-0 text-muted-foreground">
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </span>
        {icon && <span className="shrink-0">{icon}</span>}
        <span className="text-foreground">{title}</span>
        {headerExtra && <span className="ml-auto flex items-center gap-1.5">{headerExtra}</span>}
      </button>
      {open && subtitle && (
        <div className="px-3 pb-2 -mt-1 text-[11px] text-muted-foreground">{subtitle}</div>
      )}
      <div className={cn(open ? 'block' : 'hidden')}>{children}</div>
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
