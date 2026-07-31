/**
 * Minimal context menu — no Radix dependency. Open via `onContextMenu`,
 * positions absolutely at the mouse coords, closes on outside click /
 * Escape / item click. Items receive an `onSelect` callback.
 *
 * Why hand-rolled: @radix-ui/react-context-menu would be ideal but
 * couldn't be installed cleanly in the current pnpm state. The IDE-side
 * menu (file tree) only needs a small static set of items, no nested
 * submenus, so the surface area stays trivial.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight } from 'lucide-react';
import { cn } from '../../lib/utils.js';

export interface ContextMenuItem {
  id: string;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  shortcut?: string;
  destructive?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
  /** Nested items — rendered as a flyout submenu that opens on hover. */
  submenu?: ContextMenuItem[];
  /** Leaf action. Omitted for submenu parents. */
  onSelect?: () => void;
}

interface UseContextMenuResult {
  /** Spread onto the element that should open the menu on right-click. */
  triggerProps: {
    onContextMenu: (e: React.MouseEvent) => void;
  };
  /** Open from a visible affordance (for example an ellipsis button). */
  openAt: (x: number, y: number) => void;
  /** Render this near the root; it portals itself. */
  Menu: React.ReactElement | null;
}

export function useContextMenu(items: ContextMenuItem[]): UseContextMenuResult {
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const openAt = useCallback((x: number, y: number) => setOpen({ x, y }), []);

  return {
    triggerProps: {
      onContextMenu: (e) => {
        e.preventDefault();
        e.stopPropagation();
        openAt(e.clientX, e.clientY);
      },
    },
    openAt,
    Menu: open ? <ContextMenuView pos={open} items={items} onClose={close} /> : null,
  };
}

interface ContextMenuViewProps {
  pos: { x: number; y: number };
  items: ContextMenuItem[];
  onClose: () => void;
}

function ContextMenuView({ pos, items, onClose }: ContextMenuViewProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [adjusted, setAdjusted] = useState(pos);

  // Clamp to viewport once mounted so the menu never spills off-screen.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = pos.x;
    let y = pos.y;
    if (x + rect.width > vw - 4) x = vw - rect.width - 4;
    if (y + rect.height > vh - 4) y = vh - rect.height - 4;
    if (x !== pos.x || y !== pos.y) setAdjusted({ x, y });
  }, [pos]);

  // Close on outside click + Escape.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={ref}
      role="menu"
      className="fixed z-[100] min-w-[180px] py-1 rounded-md border bg-popover text-popover-foreground shadow-xl shadow-black/30 text-[12px]"
      style={{ left: adjusted.x, top: adjusted.y }}
    >
      {items.map((item) => <MenuItem key={item.id} item={item} onClose={onClose} />)}
    </div>,
    document.body,
  );
}

function MenuItem({ item, onClose }: { item: ContextMenuItem; onClose: () => void }) {
  const Icon = item.icon;
  const [subOpen, setSubOpen] = useState(false);
  const rowClass = cn(
    'w-full flex items-center gap-2 px-2.5 py-1 text-left transition-colors',
    item.disabled
      ? 'text-muted-foreground/50 cursor-not-allowed'
      : item.destructive
        ? 'text-destructive hover:bg-destructive/10'
        : 'hover:bg-accent hover:text-accent-foreground',
  );

  // Submenu parent — opens a flyout on hover. The flyout is a DOM descendant so
  // moving the cursor from the row into it doesn't fire the row's mouseleave.
  if (item.submenu) {
    return (
      <>
        {item.separatorBefore && <div className="h-px bg-border my-1 mx-1" />}
        <div className="relative" onMouseEnter={() => setSubOpen(true)} onMouseLeave={() => setSubOpen(false)}>
          <button type="button" role="menuitem" className={cn(rowClass, subOpen && 'bg-accent text-accent-foreground')}>
            {Icon && <Icon className="h-3 w-3 shrink-0" />}
            <span className="flex-1">{item.label}</span>
            <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
          </button>
          {subOpen && (
            <div
              role="menu"
              className="absolute left-full top-0 -mt-1 ml-0.5 min-w-[160px] max-h-72 overflow-auto py-1 rounded-md border bg-popover text-popover-foreground shadow-xl shadow-black/30"
            >
              {item.submenu.map((sub) => <MenuItem key={sub.id} item={sub} onClose={onClose} />)}
            </div>
          )}
        </div>
      </>
    );
  }

  return (
    <>
      {item.separatorBefore && <div className="h-px bg-border my-1 mx-1" />}
      <button
        type="button"
        role="menuitem"
        disabled={item.disabled}
        onClick={(e) => {
          // The portal renders to document.body, but React synthetic events
          // still bubble through the *component* tree — i.e. up to the
          // trigger row/card's onClick (which opens the project). Stop here
          // so a menu-item click never doubles as a row click.
          e.stopPropagation();
          if (item.disabled) return;
          item.onSelect?.();
          onClose();
        }}
        className={rowClass}
      >
        {Icon && <Icon className="h-3 w-3 shrink-0" />}
        <span className="flex-1">{item.label}</span>
        {item.shortcut && (
          <span className="text-[10px] text-muted-foreground/70 font-mono">{item.shortcut}</span>
        )}
      </button>
    </>
  );
}
