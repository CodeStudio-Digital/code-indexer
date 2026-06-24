/**
 * Work-area tab bar — one chip per open query/data/structure tab, mirroring the
 * Monaco `EditorTabBar`: a horizontally-scrolling strip (hidden scrollbar) with
 * an active accent bar, hover/middle-click close, a right-click context menu,
 * drag-to-reorder, and — when the chips don't fit ("não cabe na tela") — an
 * overflow dropdown (searchable list of every open tab).
 */
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Table2, Eye, TerminalSquare, Columns3, Share2, MoreHorizontal, Plus, Search, X } from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import { useContextMenu, type ContextMenuItem } from '../../../components/ui/context-menu.js';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
} from '../../../components/ui/dropdown-menu.js';
import { Input } from '../../../components/ui/input.js';
import type { UseDbClient } from '../useDbClient.js';
import type { WorkTab } from '../types.js';

const DND_MIME = 'application/x-mcp-db-tab';

function tabLabel(tab: WorkTab, queryWord: string): string {
  if (tab.kind === 'query') return tab.schema ? `${queryWord} · ${tab.schema}` : `${queryWord} ${tab.seq ?? ''}`.trim();
  return tab.title;
}

function TabIcon({ kind }: { kind: WorkTab['kind'] }) {
  if (kind === 'query') return <TerminalSquare className="h-3.5 w-3.5 shrink-0 text-violet-400" />;
  if (kind === 'structure') return <Columns3 className="h-3.5 w-3.5 shrink-0 text-amber-400" />;
  if (kind === 'er') return <Share2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />;
  return <Table2 className="h-3.5 w-3.5 shrink-0 text-sky-400" />;
}

export function WorkAreaTabBar({ db }: { db: UseDbClient }) {
  const { t } = useTranslation('dbClient');
  const queryWord = t('tabs.query');
  const stripRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  // Detect overflow so the dropdown only appears when it's useful.
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const check = () => setOverflow(el.scrollWidth > el.clientWidth + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [db.workTabs.length]);

  // Scroll the active tab into view when it changes.
  useEffect(() => {
    const el = stripRef.current?.querySelector<HTMLElement>(`[data-tab-id="${cssEscape(db.activeTabId ?? '')}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, [db.activeTabId]);

  function onNewQuery(): void {
    if (db.activeConnectionId != null) db.openQueryTab(db.activeConnectionId);
  }

  return (
    <div className="relative flex h-8 shrink-0 items-stretch border-b bg-card/20">
      <div ref={stripRef} className="flex min-w-0 flex-1 items-stretch overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
        {db.workTabs.length === 0 ? (
          <div className="flex items-center px-3 text-[11px] text-muted-foreground">{t('tabs.empty')}</div>
        ) : (
          db.workTabs.map((tab) => (
            <TabChip
              key={tab.id}
              tab={tab}
              label={tabLabel(tab, queryWord)}
              active={tab.id === db.activeTabId}
              dropBefore={dropTarget === tab.id}
              onActivate={() => db.activateTab(tab.id)}
              onClose={() => db.closeTab(tab.id)}
              onCloseOthers={() => db.workTabs.filter((x) => x.id !== tab.id).forEach((x) => db.closeTab(x.id))}
              onCloseAll={() => db.workTabs.slice().forEach((x) => db.closeTab(x.id))}
              onDragStartChip={(e) => e.dataTransfer.setData(DND_MIME, tab.id)}
              onDragOverChip={(e) => {
                if (e.dataTransfer.types.includes(DND_MIME)) {
                  e.preventDefault();
                  setDropTarget(tab.id);
                }
              }}
              onDropChip={(e) => {
                const id = e.dataTransfer.getData(DND_MIME);
                setDropTarget(null);
                if (id && id !== tab.id) db.reorderTab(id, tab.id);
              }}
              t={t}
            />
          ))
        )}
      </div>

      <button
        type="button"
        className="grid h-8 w-8 shrink-0 place-items-center border-l text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground disabled:opacity-40"
        title={t('tabs.newQuery')}
        aria-label={t('tabs.newQuery')}
        onClick={onNewQuery}
        disabled={db.activeConnectionId == null}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>

      {overflow && <OverflowDropdown db={db} queryWord={queryWord} t={t} />}
    </div>
  );
}

interface ChipProps {
  tab: WorkTab;
  label: string;
  active: boolean;
  dropBefore: boolean;
  onActivate: () => void;
  onClose: () => void;
  onCloseOthers: () => void;
  onCloseAll: () => void;
  onDragStartChip: (e: DragEvent) => void;
  onDragOverChip: (e: DragEvent) => void;
  onDropChip: (e: DragEvent) => void;
  t: (k: string, o?: Record<string, unknown>) => string;
}

function TabChip({
  tab, label, active, dropBefore, onActivate, onClose, onCloseOthers, onCloseAll,
  onDragStartChip, onDragOverChip, onDropChip, t,
}: ChipProps) {
  const items: ContextMenuItem[] = [
    { id: 'close', label: t('tabs.close'), onSelect: onClose },
    { id: 'close-others', label: t('tabs.closeOthers'), onSelect: onCloseOthers },
    { id: 'close-all', label: t('tabs.closeAll'), separatorBefore: true, destructive: true, onSelect: onCloseAll },
  ];
  const { triggerProps, Menu } = useContextMenu(items);

  return (
    <>
      <div
        data-tab-id={tab.id}
        draggable
        onDragStart={onDragStartChip}
        onDragOver={onDragOverChip}
        onDrop={onDropChip}
        onClick={onActivate}
        onMouseDown={(e) => {
          if (e.button === 1) {
            e.preventDefault();
            onClose();
          }
        }}
        title={label}
        className={cn(
          'group relative flex min-w-[120px] max-w-[220px] shrink-0 cursor-pointer select-none items-center gap-1.5 border-r pl-3 pr-1.5 text-xs',
          active ? 'bg-background text-foreground' : 'bg-card/10 text-muted-foreground hover:bg-muted/40 hover:text-foreground',
        )}
        {...triggerProps}
      >
        {dropBefore && <span aria-hidden className="absolute inset-y-0 left-0 z-10 w-0.5 bg-primary" />}
        {active && <span aria-hidden className="absolute inset-x-0 top-0 h-[2px] bg-primary" />}
        <TabIcon kind={tab.kind} />
        <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          aria-label={t('tabs.closeAria', { name: label })}
          className="grid h-4 w-4 shrink-0 place-items-center rounded-sm text-muted-foreground/70 opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      {Menu}
    </>
  );
}

function OverflowDropdown({
  db,
  queryWord,
  t,
}: {
  db: UseDbClient;
  queryWord: string;
  t: (k: string, o?: Record<string, unknown>) => string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    if (!query.trim()) return db.workTabs;
    const q = query.toLowerCase();
    return db.workTabs.filter((tab) => tabLabel(tab, queryWord).toLowerCase().includes(q));
  }, [db.workTabs, query, queryWord]);

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="grid h-8 w-8 shrink-0 place-items-center border-l text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
          aria-label={t('tabs.list')}
          title={t('tabs.list')}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 overflow-hidden p-0">
        <div className="border-b p-1.5">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('tabs.filterOpen')}
              className="h-7 pl-7 text-[12px]"
              autoFocus
            />
          </div>
        </div>
        <div className="max-h-[320px] overflow-y-auto">
          {filtered.length === 0 && (
            <div className="px-3 py-3 text-center text-[11px] text-muted-foreground">{t('tabs.noMatch')}</div>
          )}
          {filtered.map((tab) => (
            <div
              key={tab.id}
              className={cn(
                'group flex cursor-pointer items-center gap-2 px-3 py-1.5',
                tab.id === db.activeTabId ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/40',
              )}
              onClick={() => {
                db.activateTab(tab.id);
                setOpen(false);
              }}
            >
              <TabIcon kind={tab.kind} />
              <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{tabLabel(tab, queryWord)}</span>
              <button
                type="button"
                className="grid h-5 w-5 shrink-0 place-items-center rounded-sm text-muted-foreground/70 opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  db.closeTab(tab.id);
                }}
                aria-label={t('tabs.closeAria', { name: tabLabel(tab, queryWord) })}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(value);
  return value.replace(/(["\\\]])/g, '\\$1');
}
