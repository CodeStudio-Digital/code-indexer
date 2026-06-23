import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog.js';
import { type CommandAction, type CommandGroup, filterCommands } from './command-actions.js';
import { cn } from '../lib/utils.js';

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions: CommandAction[];
}

/**
 * Static group → i18n key map. Hoisted to module scope so it is allocated
 * once, not rebuilt on every render (the resolved labels are memoized below).
 */
const GROUP_LABEL_KEYS: Record<CommandGroup, string> = {
  nav: 'commandPalette.groupNav',
  projects: 'commandPalette.groupProjects',
  recent: 'commandPalette.groupRecent',
  actions: 'commandPalette.groupActions',
};

interface CommandRowProps {
  action: CommandAction;
  index: number;
  isActive: boolean;
  /** Group label to render above this row when it starts a new group. */
  header?: string;
  onMouseMove: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
}

/**
 * Memoized row. Handlers are shared, stable references passed from the parent
 * (the row carries its index via `data-idx`), so re-renders of the palette no
 * longer allocate a fresh closure per row. Combined with virtualization this
 * keeps ⌘K cheap even with 100+ projects/recent sessions in the list.
 */
const CommandRow = memo(function CommandRow({
  action,
  index,
  isActive,
  header,
  onMouseMove,
  onClick,
}: CommandRowProps) {
  const Icon = action.icon;
  return (
    <>
      {header && (
        <div className="px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {header}
        </div>
      )}
      <button
        type="button"
        data-idx={index}
        onMouseMove={onMouseMove}
        onClick={onClick}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm',
          isActive ? 'bg-accent text-accent-foreground' : 'text-foreground',
        )}
      >
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="truncate">{action.label}</span>
        {action.hint && (
          <span className="ml-auto truncate text-xs text-muted-foreground">{action.hint}</span>
        )}
      </button>
    </>
  );
});

/**
 * ⌘K command palette. A thin filtered list over the injected `actions`
 * (built in AppShell from nav destinations + projects + recent sessions +
 * theme/language toggles). Keyboard-first: ↑/↓ move, Enter runs, Esc closes
 * (handled by the Dialog). Actions are pre-sorted by group, so the flat
 * `active` index lines up with the grouped render below.
 *
 * The result list is virtualized — only on-screen rows mount — and the row
 * event handlers are shared/stable to avoid per-row closure churn that showed
 * up as a hot allocation site in heap profiling.
 */
export function CommandPalette({ open, onOpenChange, actions }: CommandPaletteProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  // Scroll element kept in STATE (via callback ref), not a plain ref. The
  // palette stays mounted while only the Dialog's portal subtree mounts on
  // open; assigning a ref object would not re-render, so the virtualizer would
  // keep reading a stale `null` scroll element and render an empty list until
  // some unrelated state change (mouse move, keystroke) forced a re-render.
  // Storing the node in state makes attachment itself trigger that re-render,
  // so rows paint immediately on open.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);

  const filtered = useMemo(() => filterCommands(actions, query), [actions, query]);

  const groupLabel = useMemo<Record<CommandGroup, string>>(
    () => ({
      nav: t(GROUP_LABEL_KEYS.nav),
      projects: t(GROUP_LABEL_KEYS.projects),
      recent: t(GROUP_LABEL_KEYS.recent),
      actions: t(GROUP_LABEL_KEYS.actions),
    }),
    [t],
  );

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => 34,
    overscan: 10,
  });

  // Fresh palette on every open; clamp the cursor as the list shrinks.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
    }
  }, [open]);
  useEffect(() => {
    setActive((i) => Math.min(i, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);
  // Keep the active row visible as the cursor moves (replaces scrollIntoView).
  useEffect(() => {
    if (filtered.length > 0) virtualizer.scrollToIndex(active, { align: 'auto' });
  }, [active, filtered.length, virtualizer]);

  const run = useCallback(
    (a: CommandAction): void => {
      onOpenChange(false);
      a.run();
    },
    [onOpenChange],
  );

  // One shared handler per event type for all rows. Recreated only when
  // `filtered`/`run` change (a single allocation), never once-per-row.
  const handleRowMouseMove = useCallback((e: React.MouseEvent<HTMLButtonElement>): void => {
    const idx = Number(e.currentTarget.dataset.idx);
    setActive((cur) => (cur === idx ? cur : idx));
  }, []);
  const handleRowClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>): void => {
      const idx = Number(e.currentTarget.dataset.idx);
      const a = filtered[idx];
      if (a) run(a);
    },
    [filtered, run],
  );

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const a = filtered[active];
      if (a) run(a);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="top-[14%] max-w-xl translate-y-0 gap-0 overflow-hidden p-0"
        onKeyDown={onKeyDown}
      >
        <DialogTitle className="sr-only">{t('commandPalette.placeholder')}</DialogTitle>
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('commandPalette.placeholder')}
            className="h-11 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div ref={setScrollEl} className="max-h-[55vh] overflow-y-auto p-1.5">
          {filtered.length === 0 && (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">
              {t('commandPalette.empty')}
            </div>
          )}
          {filtered.length > 0 && (
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
              {virtualizer.getVirtualItems().map((vi) => {
                const a = filtered[vi.index];
                const prev = vi.index > 0 ? filtered[vi.index - 1] : undefined;
                const header = !prev || prev.group !== a.group ? groupLabel[a.group] : undefined;
                return (
                  <div
                    key={a.id}
                    data-index={vi.index}
                    ref={virtualizer.measureElement}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${vi.start}px)`,
                    }}
                  >
                    <CommandRow
                      action={a}
                      index={vi.index}
                      isActive={vi.index === active}
                      header={header}
                      onMouseMove={handleRowMouseMove}
                      onClick={handleRowClick}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
