/**
 * Standardised collapsible section header for `AgentsSidebar`.
 *
 * Replicates the visual pattern of the original "Agentes" header
 * (border top + bottom, leading icon, label, optional trailing count
 * badge) across every section of the sidebar (Projects, Agents per
 * project, Configured roles, Microservices, Agents). Each section
 * collapses independently; the open/closed state is persisted per
 * section key in localStorage so the user's preference survives
 * reloads + remounts.
 */
import { useCallback, useEffect, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { ChevronDown } from 'lucide-react';
import { Badge } from '../../../components/ui/badge.js';
import { cn } from '../../../lib/utils.js';

export interface SidebarSectionProps {
  /** Stable key used for the localStorage open/closed flag. */
  storageKey: string;
  icon: LucideIcon;
  title: string;
  /** Optional count chip on the right (e.g. number of agents). */
  count?: number;
  /** Optional inline action button (e.g. "+" to add an item). */
  action?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

const LS_PREFIX = 'agentsSidebar.section.';

function readStored(key: string, fallback: boolean): boolean {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(LS_PREFIX + key);
    if (raw === '1') return true;
    if (raw === '0') return false;
    return fallback;
  } catch {
    return fallback;
  }
}

export function SidebarSection({
  storageKey,
  icon: Icon,
  title,
  count,
  action,
  defaultOpen = true,
  children,
}: SidebarSectionProps) {
  const [open, setOpen] = useState(() => readStored(storageKey, defaultOpen));

  useEffect(() => {
    try {
      window.localStorage.setItem(LS_PREFIX + storageKey, open ? '1' : '0');
    } catch {
      /* private mode / quota — best-effort */
    }
  }, [storageKey, open]);

  // C1 — outside components (e.g. the autonomy incident banner's
  // "view panel" link) can force a section open by storageKey:
  //   window.dispatchEvent(new CustomEvent('mcp:sidebar-section:open',
  //     { detail: { storageKey: 'autonomy' } }))
  useEffect(() => {
    const onForceOpen = (e: Event) => {
      const detail = (e as CustomEvent<{ storageKey?: string }>).detail;
      if (detail?.storageKey === storageKey) setOpen(true);
    };
    window.addEventListener('mcp:sidebar-section:open', onForceOpen);
    return () => window.removeEventListener('mcp:sidebar-section:open', onForceOpen);
  }, [storageKey]);

  const toggle = useCallback(() => setOpen((v) => !v), []);

  return (
    <div className="border-b">
      {/* Header — same shape as the legacy "Agentes" strip: border on
          top + bottom, icon, label, trailing badge. Clicking anywhere
          on the header (except the action button) toggles the section.
          Using a button element instead of a clickable div for keyboard
          + a11y. */}
      <div className="flex items-stretch border-t bg-card/30">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className={cn(
            'flex-1 flex items-center gap-1.5 px-2.5 py-2',
            'text-left transition-colors hover:bg-muted/40',
          )}
        >
          <ChevronDown
            className={cn(
              'h-3 w-3 text-muted-foreground/60 transition-transform shrink-0',
              !open && '-rotate-90',
            )}
          />
          <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-xs font-medium truncate">{title}</span>
          {count !== undefined && (
            <Badge variant="outline" className="text-[9px] ml-auto shrink-0">
              {count}
            </Badge>
          )}
        </button>
        {action && (
          // Action button (e.g. "+ add") sits outside the toggle so
          // clicking it doesn't expand/collapse the section. Padding
          // mirrors the header so the strip stays the same height.
          <div className="flex items-center px-2 border-l" onClick={(e) => e.stopPropagation()}>
            {action}
          </div>
        )}
      </div>
      {open && <div className="p-2 space-y-2">{children}</div>}
    </div>
  );
}
