/**
 * Left pane: collection switcher + the active collection's requests, grouped
 * into collapsible folders. Manage folders in the IDE (create/rename/delete),
 * drag requests between folders, right-click a request for duplicate/move/delete,
 * or turn on selection mode for bulk move/delete.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Plus, Trash2, ChevronRight, ChevronDown, Folder, FolderPlus, Pencil, ListChecks, X, FolderInput,
} from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '../../components/ui/dropdown-menu.js';
import { prompt, confirm } from '../../components/ui/prompt-dialog.js';
import { cn } from '../../lib/utils.js';
import type { ApiCollection, ApiRequest } from './types.js';
import { RequestRow } from './collection/RequestRow.js';

type FlatItem =
  | { kind: 'top'; count: number }
  | { kind: 'folder'; folder: string; count: number; collapsed: boolean }
  | { kind: 'row'; request: ApiRequest; inFolder: boolean; folder: string | null };

interface Props {
  collections: ApiCollection[];
  requests: ApiRequest[];
  activeCollectionId: number | null;
  activeRequestId: number | null;
  onSelectCollection: (id: number) => void;
  onSelectRequest: (id: number) => void;
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

export function CollectionList(p: Props) {
  const [newReq, setNewReq] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [topCollapsed, setTopCollapsed] = useState(false);
  const [dragId, setDragId] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [rowDrop, setRowDrop] = useState<{ id: number; edge: 'top' | 'bottom' } | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());

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

  const toggle = (f: string) => setCollapsed((s) => { const n = new Set(s); n.has(f) ? n.delete(f) : n.add(f); return n; });
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
  const moveToNew = useCallback(async (rid: number) => { const n = await prompt({ title: 'Move to new folder', placeholder: 'Folder name' }); if (n?.trim()) { p.onAddFolder(n.trim()); p.onMoveRequest(rid, n.trim()); } }, [p.onAddFolder, p.onMoveRequest]);

  const newFolder = async () => { const n = await prompt({ title: 'New folder', placeholder: 'Folder name' }); if (n?.trim()) p.onAddFolder(n.trim()); };
  const rename = async (f: string) => { const n = await prompt({ title: 'Rename folder', defaultValue: f }); if (n?.trim() && n.trim() !== f) p.onRenameFolder(f, n.trim()); };
  const delFolder = async (f: string) => { if (await confirm({ title: `Delete folder “${f}”?`, description: 'Its requests move to the top level.', tone: 'destructive' })) p.onRemoveFolder(f); };

  const bulkMoveTo = (folder: string | null) => { p.onBulkMove([...selected], folder); clearSel(); };
  const bulkMoveToNew = async () => { const n = await prompt({ title: 'Move to new folder', placeholder: 'Folder name' }); if (n?.trim()) { p.onAddFolder(n.trim()); bulkMoveTo(n.trim()); } };
  const bulkDelete = async () => {
    if (await confirm({ title: `Delete ${selected.size} request(s)?`, description: 'This cannot be undone.', tone: 'destructive' })) {
      p.onBulkDelete([...selected]); clearSel();
    }
  };

  // Flatten the (collapse-aware) tree into one list so a single virtualizer can
  // window it — a large imported spec mounts only the visible rows.
  const flat = useMemo<FlatItem[]>(() => {
    const out: FlatItem[] = [];
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
  }, [top, byFolder, folderNames, collapsed, topCollapsed]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: flat.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (flat[i].kind === 'row' ? 42 : 28),
    overscan: 12,
  });

  const reqRow = (r: ApiRequest, inFolder: boolean) => (
    <RequestRow
      request={r} inFolder={inFolder} folders={folderNames}
      active={r.id === p.activeRequestId} selectMode={selectMode} selected={selected.has(r.id)}
      onOpen={p.onSelectRequest} onToggleSelect={toggleSel} onDuplicate={p.onDuplicate}
      onMove={p.onMoveRequest} onMoveToNew={moveToNew} onDelete={p.onRemoveRequest}
      onDragStart={setDragId} onDragEnd={onDragEnd}
    />
  );

  const topHeader = (count: number) => (
    <div
      onDragOver={(e) => { e.preventDefault(); setDropTarget(''); setRowDrop(null); }}
      onDrop={(e) => { e.preventDefault(); dropTo(''); }}
      onClick={() => setTopCollapsed((v) => !v)}
      className={cn('flex items-center gap-1.5 px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground border-b border-border/40 cursor-pointer hover:bg-muted/40', dropTarget === '' && dragId != null && 'bg-primary/10')}
    >
      {topCollapsed ? <ChevronRight className="h-3.5 w-3.5 shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0" />}
      <span className="flex-1">Top level</span>
      <span>{count}</span>
    </div>
  );

  const folderHeader = (f: string, count: number, isCollapsed: boolean) => (
    <div
      onDragOver={(e) => { e.preventDefault(); setDropTarget(f); setRowDrop(null); }}
      onDrop={(e) => { e.preventDefault(); dropTo(f); }}
      className={cn('group/folder flex items-center gap-1.5 px-2 py-1.5 text-xs font-medium border-b border-border/40 cursor-pointer hover:bg-muted/40',
        dropTarget === f && dragId != null && 'bg-primary/10')}
      onClick={() => toggle(f)}
    >
      {isCollapsed ? <ChevronRight className="h-3.5 w-3.5 shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0" />}
      <Folder className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      <span className="truncate flex-1">{f}</span>
      <span className="text-[10px] text-muted-foreground group-hover/folder:hidden">{count}</span>
      <div className="hidden group-hover/folder:flex items-center gap-1 text-muted-foreground">
        <button title="New request here" onClick={(e) => { e.stopPropagation(); p.onAddRequest('New request', f); }} className="hover:text-foreground"><Plus className="h-3.5 w-3.5" /></button>
        <button title="Rename folder" onClick={(e) => { e.stopPropagation(); void rename(f); }} className="hover:text-foreground"><Pencil className="h-3 w-3" /></button>
        <button title="Delete folder" onClick={(e) => { e.stopPropagation(); void delFolder(f); }} className="hover:text-red-500"><Trash2 className="h-3 w-3" /></button>
      </div>
    </div>
  );

  return (
    <div className="flex flex-col h-full">
      <div className="p-2 border-b space-y-2">
        <select className="w-full text-xs bg-background border rounded px-2 py-1"
          value={p.activeCollectionId ?? ''} onChange={(e) => p.onSelectCollection(Number(e.target.value))}>
          {p.collections.length === 0 && <option value="">No collections</option>}
          {p.collections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {p.activeCollectionId != null && (
          <div className="flex gap-1">
            <Button type="button" size="sm" variant="ghost" className="h-6 flex-1 justify-start gap-1.5 text-[11px] text-muted-foreground" onClick={newFolder}>
              <FolderPlus className="h-3.5 w-3.5" /> New folder
            </Button>
            <Button type="button" size="sm" variant={selectMode ? 'secondary' : 'ghost'} className="h-6 gap-1.5 text-[11px] text-muted-foreground"
              title="Select multiple" onClick={() => (selectMode ? clearSel() : setSelectMode(true))}>
              <ListChecks className="h-3.5 w-3.5" /> Select
            </Button>
          </div>
        )}
      </div>

      {selectMode && (
        <div className="flex items-center gap-1.5 px-2 py-1.5 border-b bg-muted/40 text-[11px]">
          <span className="text-muted-foreground">{selected.size} selected</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" className="h-6 gap-1 ml-auto" disabled={selected.size === 0}>
                <FolderInput className="h-3 w-3" /> Move to
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-64 overflow-auto">
              <DropdownMenuItem onClick={() => bulkMoveTo(null)}>Top level</DropdownMenuItem>
              {folderNames.map((f) => <DropdownMenuItem key={f} onClick={() => bulkMoveTo(f)}>{f}</DropdownMenuItem>)}
              <DropdownMenuItem onClick={() => void bulkMoveToNew()}>New folder…</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button size="sm" variant="ghost" className="h-6 gap-1 text-red-500" disabled={selected.size === 0} onClick={() => void bulkDelete()}>
            <Trash2 className="h-3 w-3" /> Delete
          </Button>
          <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-muted-foreground" title="Cancel" onClick={clearSel}><X className="h-3.5 w-3.5" /></Button>
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-auto">
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((v) => {
            const item = flat[v.index];
            const key = item.kind === 'row' ? `r:${item.request.id}` : item.kind === 'folder' ? `f:${item.folder}` : 'top';
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

      {p.activeCollectionId != null && !selectMode && (
        <form className="p-2 border-t flex gap-1"
          onSubmit={(e) => { e.preventDefault(); if (newReq.trim()) { p.onAddRequest(newReq.trim()); setNewReq(''); } }}>
          <Input value={newReq} onChange={(e) => setNewReq(e.target.value)} placeholder="New request…" className="h-7 text-xs" />
          <Button type="submit" size="sm" variant="outline" className="h-7 px-2" title="Add request"><Plus className="h-3.5 w-3.5" /></Button>
        </form>
      )}
    </div>
  );
}
