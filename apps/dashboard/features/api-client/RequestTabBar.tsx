/**
 * Open-request tabs for the active collection — clicking a request opens (or
 * focuses) a tab; multiple stay open and each is closable, like the code editor's
 * file tabs. Mirrors features/workspace/EditorTabBar: active accent, hover-reveal
 * close, middle-click close, a right-click context menu (close / others / left /
 * right / all), and an overflow "…" dropdown (with filter) when the strip can't
 * show every tab. The unsaved "Untitled" draft is a tab too (negative id) and
 * shows a dirty dot.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MoreHorizontal, Search, X } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { useContextMenu, type ContextMenuItem } from '../../components/ui/context-menu.js';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '../../components/ui/dropdown-menu.js';
import { Input } from '../../components/ui/input.js';
import { METHOD_COLOR, pathOnly } from './collection/row-format.js';
import type { ApiRequest } from './types.js';

interface Props {
  requests: ApiRequest[];
  draftRequest: ApiRequest | null;
  draftDirty: boolean;
  openTabIds: number[];
  activeRequestId: number | null;
  onActivate: (id: number) => void;
  onClose: (id: number) => void;
  onCloseOthers: (id: number) => void;
  onCloseRight: (id: number) => void;
  onCloseLeft: (id: number) => void;
  onCloseAll: () => void;
}

interface TabInfo { id: number; name: string; method: string; dirty: boolean }

export function RequestTabBar(props: Props) {
  const { requests, draftRequest, draftDirty, openTabIds, activeRequestId, onActivate, onClose } = props;
  const { t } = useTranslation('apiClient');

  const tabs = useMemo<TabInfo[]>(() =>
    openTabIds.map((id): TabInfo | null => {
      if (id < 0) return draftRequest ? { id, name: draftRequest.name, method: draftRequest.method, dirty: draftDirty } : null;
      const r = requests.find((x) => x.id === id);
      return r ? { id, name: r.name || pathOnly(r.path_template), method: r.method, dirty: false } : null;
    }).filter((x): x is TabInfo => x != null),
  [openTabIds, requests, draftRequest, draftDirty]);

  // Detect whether the inline strip overflows so the "…" dropdown shows only when useful.
  // The ResizeObserver catches container-box changes; re-running on a tab signature
  // (ids + labels) catches CONTENT-width changes — a live draft rename or an external
  // rename grows scrollWidth without changing the tab count.
  const stripRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  const tabSig = tabs.map((x) => `${x.id}:${x.name}`).join('|');
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const check = () => setOverflow(el.scrollWidth > el.clientWidth + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tabSig]);

  // Keep the active tab scrolled into view when it changes.
  useEffect(() => {
    if (activeRequestId == null) return;
    stripRef.current
      ?.querySelector<HTMLElement>(`[data-tab-id="${activeRequestId}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, [activeRequestId]);

  if (openTabIds.length === 0) {
    return <div className="h-8 shrink-0 border-b flex items-center px-3 text-[11px] text-muted-foreground">{t('tabs.noRequestOpen')}</div>;
  }

  return (
    <div className="h-8 shrink-0 border-b flex items-stretch relative">
      <div ref={stripRef} className="flex items-stretch overflow-x-auto flex-1 min-w-0" style={{ scrollbarWidth: 'none' }}>
        {tabs.map((tab, i) => (
          <TabChip
            key={tab.id}
            tab={tab}
            active={tab.id === activeRequestId}
            isFirst={i === 0}
            isLast={i === tabs.length - 1}
            single={tabs.length === 1}
            onActivate={() => onActivate(tab.id)}
            onClose={() => onClose(tab.id)}
            onCloseOthers={() => props.onCloseOthers(tab.id)}
            onCloseRight={() => props.onCloseRight(tab.id)}
            onCloseLeft={() => props.onCloseLeft(tab.id)}
            onCloseAll={props.onCloseAll}
          />
        ))}
      </div>
      {overflow && (
        <OverflowDropdown tabs={tabs} activeRequestId={activeRequestId} onPick={onActivate} onClose={onClose} />
      )}
    </div>
  );
}

interface TabChipProps {
  tab: TabInfo;
  active: boolean;
  isFirst: boolean;
  isLast: boolean;
  single: boolean;
  onActivate: () => void;
  onClose: () => void;
  onCloseOthers: () => void;
  onCloseRight: () => void;
  onCloseLeft: () => void;
  onCloseAll: () => void;
}

function TabChip({ tab, active, isFirst, isLast, single, onActivate, onClose, onCloseOthers, onCloseRight, onCloseLeft, onCloseAll }: TabChipProps) {
  const { t } = useTranslation('apiClient');
  const items: ContextMenuItem[] = [
    { id: 'close', label: t('tabs.close'), onSelect: onClose },
    { id: 'close-others', label: t('tabs.closeOthers'), disabled: single, onSelect: onCloseOthers },
    { id: 'close-left', label: t('tabs.closeLeft'), disabled: isFirst, onSelect: onCloseLeft },
    { id: 'close-right', label: t('tabs.closeRight'), disabled: isLast, onSelect: onCloseRight },
    { id: 'close-all', label: t('tabs.closeAll'), separatorBefore: true, destructive: true, onSelect: onCloseAll },
  ];
  const { triggerProps, Menu } = useContextMenu(items);

  return (
    <>
      <div
        data-tab-id={tab.id}
        onClick={onActivate}
        onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); onClose(); } }}
        title={tab.name}
        {...triggerProps}
        className={cn(
          'group/tab relative flex items-center gap-1.5 pl-2.5 pr-1 min-w-0 max-w-[200px] shrink-0 cursor-pointer border-r border-border/40 text-xs select-none',
          active ? 'bg-background text-foreground' : 'text-muted-foreground hover:bg-muted/50',
        )}
      >
        {active && <div className="absolute left-0 right-0 top-0 h-0.5 bg-primary" />}
        <span className={cn('font-mono font-semibold text-[9px] shrink-0', METHOD_COLOR[tab.method] ?? '')}>{tab.method}</span>
        <span className="flex-1 min-w-0 truncate">{tab.name}</span>
        {tab.dirty && <span className="h-1.5 w-1.5 rounded-full bg-foreground/60 shrink-0 group-hover/tab:hidden" aria-hidden />}
        <button
          type="button"
          aria-label={t('tabs.closeAria', { name: tab.name })}
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground shrink-0 hidden group-hover/tab:inline-flex"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      {Menu}
    </>
  );
}

interface OverflowDropdownProps {
  tabs: TabInfo[];
  activeRequestId: number | null;
  onPick: (id: number) => void;
  onClose: (id: number) => void;
}

function OverflowDropdown({ tabs, activeRequestId, onPick, onClose }: OverflowDropdownProps) {
  const { t } = useTranslation('apiClient');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const dirty = tabs.filter((x) => x.dirty).length;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tabs;
    return tabs.filter((x) => x.name.toLowerCase().includes(q) || x.method.toLowerCase().includes(q));
  }, [tabs, query]);

  // Reset the filter every time the menu reopens.
  useEffect(() => { if (!open) setQuery(''); }, [open]);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="h-8 w-8 shrink-0 border-l grid place-items-center text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors relative"
          aria-label={t('tabs.listAria')}
          title={t('tabs.openCount', { count: tabs.length })}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
          {dirty > 0 && <span aria-hidden className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-primary" />}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72 p-0 overflow-hidden">
        <div className="p-1.5 border-b">
          <div className="relative">
            <Search className="h-3 w-3 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('tabs.filterPlaceholder', { count: tabs.length })}
              className="h-7 text-[12px] pl-7"
              autoFocus
            />
          </div>
        </div>
        <div className="max-h-[320px] overflow-y-auto">
          {filtered.length === 0 && (
            <div className="px-3 py-3 text-[11px] text-muted-foreground text-center">{t('tabs.noMatch')}</div>
          )}
          {filtered.map((tab) => {
            const active = tab.id === activeRequestId;
            return (
              <div
                key={tab.id}
                className={cn('group flex items-center gap-2 px-3 py-1.5 cursor-pointer', active ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/40')}
                onClick={() => { onPick(tab.id); setOpen(false); }}
                title={tab.name}
              >
                <span className={cn('font-mono font-semibold text-[9px] w-9 shrink-0', METHOD_COLOR[tab.method] ?? '')}>{tab.method}</span>
                <span className="flex-1 min-w-0 truncate text-[12px] font-medium">{tab.name}</span>
                {tab.dirty && <span className="h-1.5 w-1.5 rounded-full bg-primary shrink-0" aria-hidden />}
                <button
                  type="button"
                  className="h-5 w-5 shrink-0 rounded-sm grid place-items-center text-muted-foreground/70 hover:text-destructive hover:bg-destructive/10 opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={(e) => { e.stopPropagation(); onClose(tab.id); }}
                  aria-label={t('tabs.closeAria', { name: tab.name })}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
