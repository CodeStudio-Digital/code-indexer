import { useRef, useState, type Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, GitBranch, History, Home, LockKeyhole, Search, Trash2 } from 'lucide-react';
import type { CoderWorktree, CoderWorktrees } from '@mcp/api-bus';
import { Button } from '../../components/ui/button.js';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover.js';
import { worktreeKey } from '../../state/worktree-selection.js';

interface Props {
  data: CoderWorktrees | null;
  path: string | null;
  triggerRef: Ref<HTMLButtonElement>;
  onSelect: (path: string | null) => void;
  onRemove: (item: CoderWorktree) => void;
}

export function worktreeLabel(item: CoderWorktree) {
  return item.branch || item.head.slice(0, 8) || item.path.split(/[\\/]/).filter(Boolean).pop() || item.path;
}

export function WorktreePicker({ data, path, triggerRef, onSelect, onRemove }: Props) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const openingRemoval = useRef(false);
  const primary = data?.worktrees.find(item => item.primary) ??
    { path: '', branch: null, head: '', primary: true, locked: false, prunable: false };
  const selectedKey = worktreeKey(path);
  const items = [primary, ...(data?.worktrees.filter(item => !item.primary) ?? [])];
  let current = path ? items.find(item => worktreeKey(item.path) === selectedKey) : primary;
  if (!current) {
    current = { path: path!, branch: null, head: '', primary: false, locked: false, prunable: true, historyOnly: true };
    items.push(current);
  }
  const name = (item: CoderWorktree) => item.primary ? t('worktrees.primary') : worktreeLabel(item);
  const needle = query.trim().toLowerCase();
  const matches = items.filter(item => [name(item), item.branch, item.path, item.head].some(value => value?.toLowerCase().includes(needle)));
  const select = (item: CoderWorktree) => {
    setOpen(false);
    onSelect(item.primary ? null : item.path);
  };
  const Icon = current.primary ? Home : current.historyOnly ? History : GitBranch;
  return (
    <Popover open={open} onOpenChange={value => { setOpen(value); if (value) setQuery(''); }}>
      <PopoverTrigger asChild>
        <Button ref={triggerRef} variant="outline" size="sm" title={current.path || t('worktrees.navigation')}
          aria-label={t('worktrees.pickerLabel', { name: name(current) })} className="h-7 max-w-full gap-1.5 px-2 text-xs">
          <Icon className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{name(current)}</span>
          {current.primary && current.branch && <span className="truncate font-mono text-[10px] text-muted-foreground">{current.branch}</span>}
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent aria-label={t('worktrees.navigation')} collisionPadding={8}
        className="flex max-h-[min(26rem,var(--radix-popover-content-available-height))] w-[min(25rem,calc(100vw-1rem))] flex-col p-1"
        onOpenAutoFocus={event => { event.preventDefault(); search.current?.focus(); }}
        onCloseAutoFocus={event => { if (openingRemoval.current) { event.preventDefault(); openingRemoval.current = false; } }}
        onKeyDown={event => {
          if (event.key === 'Enter' && event.target === search.current && matches[0]) {
            event.preventDefault(); select(matches[0]); return;
          }
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
          const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-worktree-option]'));
          if (!options.length) return;
          event.preventDefault();
          const index = options.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === 'ArrowDown' ? index + 1 : (index <= 0 ? options.length - 1 : index - 1);
          options[next % options.length]?.focus();
        }}>
        <div className="flex shrink-0 items-center gap-2 border-b px-2 py-1.5">
          <Search className="h-3.5 w-3.5 text-muted-foreground" />
          <input ref={search} value={query} onChange={event => setQuery(event.target.value)}
            className="h-7 min-w-0 flex-1 bg-transparent text-sm outline-none" aria-label={t('worktrees.filter')} placeholder={t('worktrees.filter')} />
        </div>
        <div className="min-h-0 overflow-y-auto py-1">
          {!matches.length && <p role="status" className="px-2 py-3 text-xs text-muted-foreground">{t('worktrees.noMatch')}</p>}
          {[false, true].map(history => {
            const group = matches.filter(item => !!item.historyOnly === history);
            if (!group.length) return null;
            return <div key={String(history)}>
              {history && <p className="px-2 py-1 text-xs text-muted-foreground">{t('worktrees.history')}</p>}
              <ul aria-label={history ? t('worktrees.history') : t('worktrees.navigation')}>
                {group.map(item => {
                  const label = name(item);
                  const RowIcon = item.primary ? Home : history ? History : GitBranch;
                  return <li key={item.path || 'primary'} className="flex items-center gap-1">
                    <button type="button" data-worktree-option aria-label={label} aria-pressed={item === current} title={item.path}
                      className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent focus-visible:bg-accent focus-visible:outline-ring"
                      onClick={() => select(item)}>
                      <RowIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{label}{item.primary && item.branch && <span className="ml-2 font-mono text-muted-foreground">{item.branch}</span>}</span>
                        {item.path && <span className="block truncate text-[11px] text-muted-foreground" dir="auto">{item.path}</span>}
                      </span>
                      {(item.locked || (item.repositoryMain && !item.primary)) && <span title={t('worktrees.locked')}><LockKeyhole aria-label={t('worktrees.locked')} className="h-3 w-3" /></span>}
                      {item === current && <Check className="h-3.5 w-3.5 shrink-0" />}
                    </button>
                    {!item.primary && !item.repositoryMain && !item.locked && !history &&
                      <Button variant="ghost" size="icon" className="mr-1 h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                        title={t('worktrees.removeNamed', { name: label })} aria-label={t('worktrees.removeNamed', { name: label })}
                        onClick={() => { openingRemoval.current = true; setOpen(false); onRemove(item); }}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>}
                  </li>;
                })}
              </ul>
            </div>;
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
