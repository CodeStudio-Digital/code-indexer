import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog.js';
import { type CommandAction, type CommandGroup, filterCommands } from './command-actions.js';
import { cn } from '../lib/utils.js';

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions: CommandAction[];
}

/**
 * ⌘K command palette. A thin filtered list over the injected `actions`
 * (built in AppShell from nav destinations + projects + recent sessions +
 * theme/language toggles). Keyboard-first: ↑/↓ move, Enter runs, Esc closes
 * (handled by the Dialog). Actions are pre-sorted by group, so the flat
 * `active` index lines up with the grouped render below.
 */
export function CommandPalette({ open, onOpenChange, actions }: CommandPaletteProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const activeRef = useRef<HTMLButtonElement | null>(null);

  const filtered = useMemo(() => filterCommands(actions, query), [actions, query]);

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
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const run = (a: CommandAction): void => {
    onOpenChange(false);
    a.run();
  };

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

  const groupLabel: Record<CommandGroup, string> = {
    nav: t('commandPalette.groupNav'),
    projects: t('commandPalette.groupProjects'),
    recent: t('commandPalette.groupRecent'),
    actions: t('commandPalette.groupActions'),
  };

  let lastGroup: CommandGroup | null = null;

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
        <div className="max-h-[55vh] overflow-y-auto p-1.5">
          {filtered.length === 0 && (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">
              {t('commandPalette.empty')}
            </div>
          )}
          {filtered.map((a, i) => {
            const showHeader = a.group !== lastGroup;
            lastGroup = a.group;
            const Icon = a.icon;
            const isActive = i === active;
            return (
              <Fragment key={a.id}>
                {showHeader && (
                  <div className="px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    {groupLabel[a.group]}
                  </div>
                )}
                <button
                  type="button"
                  ref={isActive ? activeRef : undefined}
                  onMouseMove={() => setActive(i)}
                  onClick={() => run(a)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm',
                    isActive ? 'bg-accent text-accent-foreground' : 'text-foreground',
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{a.label}</span>
                  {a.hint && (
                    <span className="ml-auto truncate text-xs text-muted-foreground">{a.hint}</span>
                  )}
                </button>
              </Fragment>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
