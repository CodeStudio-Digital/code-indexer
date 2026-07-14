/**
 * Left pane: collection switcher + the active collection's requests, grouped
 * into collapsible folders. Manage folders in the IDE (create/rename/delete),
 * drag requests between folders, right-click a request for duplicate/move/delete,
 * or turn on selection mode for bulk move/delete.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Plus, Trash2, ChevronRight, ChevronDown, Folder, FolderPlus, Pencil, ListChecks, X, FolderInput, FilePlus2,
  ChevronsDownUp, ChevronsUpDown, Search,
} from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '../../components/ui/dropdown-menu.js';
import { prompt, confirm } from '../../components/ui/prompt-dialog.js';
import { cn } from '../../lib/utils.js';
import type { ApiCollection, ApiRequest } from './types.js';
import { RequestRow } from './collection/RequestRow.js';
import { SidebarAction } from './collection/SidebarAction.js';
import {
  folderMatchesCollectionSearch,
  normalizeCollectionSearch,
  requestMatchesCollectionSearch,
} from './collection/collection-search.js';
import { loadApiClientUi, saveApiClientUi } from './api-client-ui-state.js';
import { ApiClientSelect } from './ApiClientSelect.js';

type FlatItem =
  | { kind: 'top'; count: number }
  | { kind: 'folder'; folder: string; count: number; collapsed: boolean }
  | { kind: 'row'; request: ApiRequest; inFolder: boolean; folder: string | null };

interface Props {
  projectId: number;
  collections: ApiCollection[];
  requests: ApiRequest[];
  activeCollectionId: number | null;
  activeRequestId: number | null;
  onSelectCollection: (id: number) => void;
  onSelectRequest: (id: number) => void;
  onNewRequest: () => void;
  onAddRequest: (name: string, folder?: string) => void;
  onRemoveRequest: (id: number) => void;
  onDuplicate: (id: number) => void;
  onAddFolder: (name: string) => void;
  onRenameFolder: (from: string, to: string) => void;
  onRemoveFolder: (name: string) => void;
  onMoveRequest: (rid: number, folder: string | null) => void;
  onReorder: (orderedIds: number[], folder: string | null) => void;
  onBulkMove: (ids: number[], folder: string | null) => void;
  onBulkDelete: (ids: number[]) => void;
}

function flatItemKey(item: FlatItem): string {
  if (item.kind === 'top') return 'top';
  if (item.kind === 'folder') return `folder:${item.folder}`;
  return `request:${item.request.id}`;
}

export function CollectionList(p: Props) {
  const { t } = useTranslation('apiClient');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [topCollapsed, setTopCollapsed] = useState(false);
  const [dragId, setDragId] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [rowDrop, setRowDrop] = useState<{ id: number; edge: 'top' | 'bottom' } | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [query, setQuery] = useState('');

  // Reset SELECTION + drag state when the active collection changes. This
  // component instance is reused across switches, so without this a bulk
  // selection (or select-mode) made in collection A would still be live in B and
  // bulkDelete/bulkMove would silently act on A's now-hidden request ids — a
  // cross-collection data-loss path. (Folder collapse is NOT reset here — it is
  // loaded from persistence by the reconcile effect below.)
  useEffect(() => {
    setSelected(new Set());
    setSelectMode(false);
    setDragId(null);
    setDropTarget(null);
    setRowDrop(null);
    setQuery('');
  }, [p.activeCollectionId]);

  const active = useMemo(() => p.collections.find((c) => c.id === p.activeCollectionId), [p.collections, p.activeCollectionId]);
  // Group + sort once per data change — folderNames is a STABLE reference between
  // renders so the memoized RequestRow's `folders` prop doesn't churn.
  const { top, byFolder, folderNames } = useMemo(() => {
    let explicit: string[] = [];
    try { explicit = active?.folders_json ? (JSON.parse(active.folders_json) as string[]) : []; } catch { explicit = []; }
    const t: ApiRequest[] = [];
    const bf = new Map<string, ApiRequest[]>();
    for (const r of p.requests) {
      const f = (r.folder ?? '').trim();
      if (!f) { t.push(r); continue; }
      if (!bf.has(f)) bf.set(f, []);
      bf.get(f)!.push(r);
    }
    return { top: t, byFolder: bf, folderNames: [...new Set([...explicit, ...bf.keys()])].sort((a, b) => a.localeCompare(b)) };
  }, [p.requests, active?.folders_json]);

  // Persist the collapse slice for the active collection (merge-write — useApiClient
  // owns the tab slice of the same entry). `seen` records the known folders so a
  // folder that appears later is treated as new → collapsed by default.
  const persistCollapse = useCallback((nextCollapsed: Set<string>, nextTop: boolean) => {
    if (p.activeCollectionId == null) return;
    saveApiClientUi(p.projectId, p.activeCollectionId, {
      collapsed: folderNames.filter((f) => nextCollapsed.has(f)),
      topCollapsed: nextTop,
      seen: folderNames,
    });
  }, [p.projectId, p.activeCollectionId, folderNames]);

  // Load + reconcile collapse from persistence. First visit (no entry) = ALL
  // folders collapsed. With an entry: keep stored-collapsed ∩ current folders, and
  // collapse any folder NOT in `seen` (created/imported since last save).
  useEffect(() => {
    if (p.activeCollectionId == null) return;
    const persisted = loadApiClientUi(p.projectId, p.activeCollectionId);
    if (!persisted) {
      setCollapsed(new Set(folderNames));
      setTopCollapsed(false);
      return;
    }
    const stored = new Set(persisted.collapsed);
    const seen = new Set(persisted.seen);
    setCollapsed(new Set(folderNames.filter((f) => stored.has(f) || !seen.has(f))));
    setTopCollapsed(persisted.topCollapsed);
  }, [p.projectId, p.activeCollectionId, folderNames]);

  const allCollapsed = folderNames.length > 0 && folderNames.every((f) => collapsed.has(f)) && topCollapsed;
  const toggleAll = () => {
    if (allCollapsed) { setCollapsed(new Set()); setTopCollapsed(false); persistCollapse(new Set(), false); }
    else { const n = new Set(folderNames); setCollapsed(n); setTopCollapsed(true); persistCollapse(n, true); }
  };

  const toggle = (f: string) => {
    const n = new Set(collapsed); n.has(f) ? n.delete(f) : n.add(f);
    setCollapsed(n); persistCollapse(n, topCollapsed);
  };
  const toggleSel = useCallback((id: number) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }), []);
  const clearSel = () => { setSelected(new Set()); setSelectMode(false); };
  // Reorder/move: rebuild the target folder's ordered id list with the dragged
  // row inserted before `beforeId` (null = append), then persist sort_order.
  const applyReorder = (folder: string | null, beforeId: number | null) => {
    if (dragId != null) {
      const list = (folder ? byFolder.get(folder) : top) ?? [];
      const ids = list.map((r) => r.id).filter((id) => id !== dragId);
      const pos = beforeId == null ? ids.length : ids.indexOf(beforeId);
      ids.splice(pos < 0 ? ids.length : pos, 0, dragId);
      p.onReorder(ids, folder);
    }
    setDragId(null); setDropTarget(null); setRowDrop(null);
  };
  const dropTo = (folder: string) => applyReorder(folder || null, null); // header drop = append to folder
  // Stable identities so React.memo on RequestRow holds across list re-renders.
  const onDragEnd = useCallback(() => { setDragId(null); setDropTarget(null); setRowDrop(null); }, []);
  const moveToNew = useCallback(async (rid: number) => { const n = await prompt({ title: t('collections.moveToNewFolderTitle'), placeholder: t('collections.folderNamePlaceholder') }); if (n?.trim()) { p.onAddFolder(n.trim()); p.onMoveRequest(rid, n.trim()); } }, [p.onAddFolder, p.onMoveRequest, t]);

  const newFolder = async () => { const n = await prompt({ title: t('collections.newFolderTitle'), placeholder: t('collections.folderNamePlaceholder') }); if (n?.trim()) p.onAddFolder(n.trim()); };
  const rename = async (f: string) => {
    const n = await prompt({ title: t('collections.renameFolderTitle'), defaultValue: f });
    const to = n?.trim();
    if (to && to !== f) {
      p.onRenameFolder(f, to);
      // Carry collapse state to the new name so a collapsed folder doesn't pop
      // open, and persist with `to` in `seen` so the reconcile effect (which runs
      // once the rename refresh lands) doesn't treat the new name as a new folder.
      const next = new Set(collapsed);
      const wasCollapsed = next.has(f);
      next.delete(f);
      if (wasCollapsed) next.add(to);
      setCollapsed(next);
      if (p.activeCollectionId != null) {
        saveApiClientUi(p.projectId, p.activeCollectionId, {
          collapsed: [...next], topCollapsed, seen: [...new Set([...folderNames, to])],
        });
      }
    }
  };
  const delFolder = async (f: string) => { if (await confirm({ title: t('collections.deleteFolderConfirmTitle', { name: f }), description: t('collections.deleteFolderConfirmBody'), tone: 'destructive' })) p.onRemoveFolder(f); };

  const bulkMoveTo = (folder: string | null) => { p.onBulkMove([...selected], folder); clearSel(); };
  const bulkMoveToNew = async () => { const n = await prompt({ title: t('collections.moveToNewFolderTitle'), placeholder: t('collections.folderNamePlaceholder') }); if (n?.trim()) { p.onAddFolder(n.trim()); bulkMoveTo(n.trim()); } };
  const bulkDelete = async () => {
    if (await confirm({ title: t('collections.bulkDeleteConfirmTitle', { count: selected.size }), description: t('collections.bulkDeleteConfirmBody'), tone: 'destructive' })) {
      p.onBulkDelete([...selected]); clearSel();
    }
  };

  const normalizedQuery = useMemo(() => normalizeCollectionSearch(query), [query]);
  const isSearching = normalizedQuery.length > 0;

  // A matching request keeps its parent folder visible; a matching folder name
  // exposes all of its children. Search temporarily expands results without
  // mutating the user's persisted collapse state.
  const searchTree = useMemo(() => {
    if (!isSearching) return null;
    const visibleTop = top.filter((request) => requestMatchesCollectionSearch(request, normalizedQuery));
    const visibleFolders = folderNames.flatMap((folder) => {
      const requests = byFolder.get(folder) ?? [];
      const visibleRequests = folderMatchesCollectionSearch(folder, normalizedQuery)
        ? requests
        : requests.filter((request) => requestMatchesCollectionSearch(request, normalizedQuery));
      return visibleRequests.length > 0 || folderMatchesCollectionSearch(folder, normalizedQuery)
        ? [{ folder, requests: visibleRequests }]
        : [];
    });
    return { top: visibleTop, folders: visibleFolders };
  }, [isSearching, normalizedQuery, top, folderNames, byFolder]);

  // Flatten the (collapse-aware) tree into one list so a single virtualizer can
  // window it — a large imported spec mounts only the visible rows.
  const flat = useMemo<FlatItem[]>(() => {
    const out: FlatItem[] = [];
    if (searchTree) {
      if (searchTree.top.length > 0) {
        if (folderNames.length > 0) out.push({ kind: 'top', count: searchTree.top.length });
        for (const request of searchTree.top) out.push({ kind: 'row', request, inFolder: false, folder: null });
      }
      for (const { folder, requests } of searchTree.folders) {
        out.push({ kind: 'folder', folder, count: requests.length, collapsed: false });
        for (const request of requests) out.push({ kind: 'row', request, inFolder: true, folder });
      }
      return out;
    }
    if (folderNames.length > 0) {
      out.push({ kind: 'top', count: top.length });
      if (!topCollapsed) for (const r of top) out.push({ kind: 'row', request: r, inFolder: false, folder: null });
    } else {
      for (const r of top) out.push({ kind: 'row', request: r, inFolder: false, folder: null });
    }
    for (const f of folderNames) {
      const reqs = byFolder.get(f) ?? [];
      out.push({ kind: 'folder', folder: f, count: reqs.length, collapsed: collapsed.has(f) });
      if (!collapsed.has(f)) for (const r of reqs) out.push({ kind: 'row', request: r, inFolder: true, folder: f });
    }
    return out;
  }, [top, byFolder, folderNames, collapsed, topCollapsed, searchTree]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: flat.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (flat[i].kind === 'row' ? 42 : 28),
    getItemKey: (i) => (flat[i] ? flatItemKey(flat[i]) : `missing:${i}`),
    overscan: 12,
  });

  const reqRow = (r: ApiRequest, inFolder: boolean) => (
    <RequestRow
      request={r} inFolder={inFolder} folders={folderNames}
      active={r.id === p.activeRequestId} selectMode={selectMode} selected={selected.has(r.id)}
      allowDrag={!isSearching}
      onOpen={p.onSelectRequest} onToggleSelect={toggleSel} onDuplicate={p.onDuplicate}
      onMove={p.onMoveRequest} onMoveToNew={moveToNew} onDelete={p.onRemoveRequest}
      onDragStart={setDragId} onDragEnd={onDragEnd}
    />
  );

  const topHeader = (count: number) => (
    <div
      onDragOver={(e) => { e.preventDefault(); setDropTarget(''); setRowDrop(null); }}
      onDrop={(e) => { e.preventDefault(); dropTo(''); }}
      onClick={() => {
        if (isSearching) return;
        const nt = !topCollapsed; setTopCollapsed(nt); persistCollapse(collapsed, nt);
      }}
      className={cn('flex items-center gap-1.5 px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground border-b border-border/40 cursor-pointer hover:bg-muted/40', dropTarget === '' && dragId != null && 'bg-primary/10')}
    >
      {topCollapsed ? <ChevronRight className="h-3.5 w-3.5 shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0" />}
      <span className="flex-1">{t('collections.topLevel')}</span>
      <span>{count}</span>
    </div>
  );

  const folderHeader = (f: string, count: number, isCollapsed: boolean) => (
    <div
      onDragOver={(e) => { e.preventDefault(); setDropTarget(f); setRowDrop(null); }}
      onDrop={(e) => { e.preventDefault(); dropTo(f); }}
      className={cn('group/folder flex items-center gap-1.5 px-2 py-1.5 text-xs font-medium border-b border-border/40 cursor-pointer hover:bg-muted/40',
        dropTarget === f && dragId != null && 'bg-primary/10')}
      onClick={() => { if (!isSearching) toggle(f); }}
    >
      {isCollapsed ? <ChevronRight className="h-3.5 w-3.5 shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0" />}
      <Folder className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      <span className="truncate flex-1">{f}</span>
      <span className="text-[10px] text-muted-foreground group-hover/folder:hidden">{count}</span>
      <div className="hidden group-hover/folder:flex items-center gap-1 text-muted-foreground">
        <button title={t('collections.newRequestHere')} onClick={(e) => { e.stopPropagation(); p.onAddRequest(t('collections.newRequestDefaultName'), f); }} className="hover:text-foreground"><Plus className="h-3.5 w-3.5" /></button>
        <button title={t('collections.renameFolder')} onClick={(e) => { e.stopPropagation(); void rename(f); }} className="hover:text-foreground"><Pencil className="h-3 w-3" /></button>
        <button title={t('collections.deleteFolder')} onClick={(e) => { e.stopPropagation(); void delFolder(f); }} className="hover:text-red-500"><Trash2 className="h-3 w-3" /></button>
      </div>
    </div>
  );

  return (
    <div className="flex flex-col h-full">
      <div className="p-2 border-b space-y-2">
        <ApiClientSelect
          value={p.activeCollectionId == null ? '' : String(p.activeCollectionId)}
          onValueChange={(value) => { if (value) p.onSelectCollection(Number(value)); }}
          options={p.collections.length === 0
            ? [{ value: '', label: t('collections.noCollections'), disabled: true }]
            : p.collections.map((collection) => ({ value: String(collection.id), label: collection.name }))}
          disabled={p.collections.length === 0}
          ariaLabel={t('collectionsDialog.title')}
          triggerClassName="w-full"
        />
        <div className="flex items-center gap-0.5">
          <SidebarAction icon={FilePlus2} label={t('collections.newRequest')} onClick={p.onNewRequest} />
          {p.activeCollectionId != null && (
            <>
              <SidebarAction icon={FolderPlus} label={t('collections.newFolder')} onClick={() => void newFolder()} />
              <SidebarAction icon={ListChecks} label={t('collections.select')} active={selectMode} onClick={() => (selectMode ? clearSel() : setSelectMode(true))} />
              {folderNames.length > 0 && !isSearching && (
                <SidebarAction
                  icon={allCollapsed ? ChevronsUpDown : ChevronsDownUp}
                  label={allCollapsed ? t('collections.expandAll') : t('collections.collapseAll')}
                  onClick={toggleAll}
                />
              )}
            </>
          )}
        </div>
        {p.activeCollectionId != null && (
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('collections.searchPlaceholder')}
              aria-label={t('collections.searchPlaceholder')}
              className="h-7 w-full rounded border border-border bg-background pl-7 pr-7 text-xs outline-none placeholder:text-muted-foreground focus:border-primary/70 focus:ring-1 focus:ring-primary/30"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                title={t('collections.clearSearch')}
                className="absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        )}
      </div>

      {selectMode && (
        <div className="flex items-center gap-1.5 px-2 py-1.5 border-b bg-muted/40 text-[11px]">
          <span className="text-muted-foreground">{t('collections.selectedCount', { count: selected.size })}</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" className="h-6 gap-1 ml-auto" disabled={selected.size === 0}>
                <FolderInput className="h-3 w-3" /> {t('collections.moveTo')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-64 overflow-auto">
              <DropdownMenuItem onClick={() => bulkMoveTo(null)}>{t('collections.topLevel')}</DropdownMenuItem>
              {folderNames.map((f) => <DropdownMenuItem key={f} onClick={() => bulkMoveTo(f)}>{f}</DropdownMenuItem>)}
              <DropdownMenuItem onClick={() => void bulkMoveToNew()}>{t('collections.newFolderMenuItem')}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button size="sm" variant="ghost" className="h-6 gap-1 text-red-500" disabled={selected.size === 0} onClick={() => void bulkDelete()}>
            <Trash2 className="h-3 w-3" /> {t('collections.delete')}
          </Button>
          <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-muted-foreground" title={t('collections.cancel')} onClick={clearSel}><X className="h-3.5 w-3.5" /></Button>
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-auto">
        {isSearching && flat.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            {t('collections.noSearchResults', { query: query.trim() })}
          </div>
        )}
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((v) => {
            const item = flat[v.index];
            const key = flatItemKey(item);
            const edge = item.kind === 'row' && rowDrop?.id === item.request.id ? rowDrop.edge : null;
            const rowDnd = item.kind === 'row' && dragId != null && dragId !== item.request.id
              ? {
                  onDragOver: (e: React.DragEvent) => {
                    e.preventDefault();
                    const rect = e.currentTarget.getBoundingClientRect();
                    setRowDrop({ id: item.request.id, edge: (e.clientY - rect.top) < rect.height / 2 ? 'top' : 'bottom' });
                    setDropTarget(null);
                  },
                  onDrop: (e: React.DragEvent) => {
                    e.preventDefault();
                    const isTop = (rowDrop?.edge ?? 'top') === 'top';
                    let beforeId: number | null;
                    if (isTop) beforeId = item.request.id;
                    else { const next = flat[v.index + 1]; beforeId = next?.kind === 'row' && next.folder === item.folder ? next.request.id : null; }
                    applyReorder(item.folder, beforeId);
                  },
                }
              : {};
            return (
              <div
                key={key}
                data-index={v.index}
                ref={virtualizer.measureElement}
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${v.start}px)` }}
                {...rowDnd}
              >
                {edge === 'top' && <div className="absolute left-0 right-0 top-0 h-0.5 bg-primary z-10" />}
                {edge === 'bottom' && <div className="absolute left-0 right-0 bottom-0 h-0.5 bg-primary z-10" />}
                {item.kind === 'top' && topHeader(item.count)}
                {item.kind === 'folder' && folderHeader(item.folder, item.count, item.collapsed)}
                {item.kind === 'row' && reqRow(item.request, item.inFolder)}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
