/**
 * Generic file pane — the same component drives both sides; only its `adapter`
 * differs (local project files vs remote SFTP). Owns its cwd/listing, the
 * sorted view of it, and Ctrl/Shift multi-select; delegates chrome to
 * `FilePaneHeader`, actions to `usePaneActions`/`usePaneExtraActions`, the
 * right-click menu to `usePaneMenu` and key handling to `usePaneKeyboard`.
 *
 * The list is VIRTUALIZED (unconditionally — one render path, no threshold),
 * which is why rows have a fixed `ROW_HEIGHT` and why dragging near an edge has
 * to auto-scroll: an off-screen row has no DOM node to drop onto.
 */
import { useCallback, useEffect, useMemo, useState, type DragEvent, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import { cn } from '../../../lib/utils.js';
import { FilePaneRow } from './FilePaneRow.js';
import { hasPanePayload, readPanePayload, setPanePayload } from './pane-dnd.js';
import { usePaneActions } from './use-pane-actions.js';
import { usePaneMenu } from './use-pane-menu.js';
import { FilePaneHeader } from './FilePaneHeader.js';
import { usePaneExtraActions } from './use-pane-extra-actions.js';
import { usePaneKeyboard } from './use-pane-keyboard.js';
import { usePaneDragScroll } from './use-pane-dragscroll.js';
import { sortEntries, type SortKey, type SortState } from './pane-sort.js';
import { ROW_HEIGHT, type ColumnId, type ColumnVisibility, type ColumnWidths } from './column-config.js';
import type { FsAdapter, FsItem } from './fs-adapter.js';
import type { PaneSelectionStore } from './pane-selection.js';

type Kind = 'local' | 'remote';

interface FilePaneProps {
  adapter: FsAdapter;
  useSel: PaneSelectionStore;
  otherKind: Kind;
  otherCwd: string;
  /** Bump to force a re-list (after a transfer/zip into this pane). */
  refreshKey: number;
  onCwdChange: (cwd: string) => void;
  onTransfer: (from: Kind, to: Kind, destDir: string, items: FsItem[]) => void;
  onOpenFile?: (item: FsItem) => void;
  /** Remote-only chmod/chown entry point. */
  onEditPermissions?: (item: FsItem) => void;
  onZip: (cwd: string, names: string[]) => Promise<boolean> | void;
  onExtract: (cwd: string, name: string) => Promise<boolean> | void;
  /** Which metadata columns are visible (shared by both panes). */
  columns: ColumnVisibility;
  columnWidths: ColumnWidths;
  onToggleColumn: (id: ColumnId) => void;
  onColumnWidthChange: (id: ColumnId, width: number) => void;
  /** Sort order, shared by both panes so the layout stays symmetric. */
  sort: SortState;
  onSort: (key: SortKey) => void;
  /** Create an empty file — the owner supplies the transport per side. */
  createFile: (dir: string, name: string) => Promise<void>;
}

export function FilePane(props: FilePaneProps) {
  const {
    adapter,
    useSel,
    otherKind,
    otherCwd,
    refreshKey,
    onCwdChange,
    onTransfer,
    onOpenFile,
    onEditPermissions,
    onZip,
    onExtract,
    columns,
    columnWidths,
    onToggleColumn,
    onColumnWidthChange,
    sort,
    onSort,
    createFile,
  } = props;
  const { t } = useTranslation('ssh');
  const [cwd, setCwd] = useState<string | null>(null);
  const [entries, setEntries] = useState<FsItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  useSel((s) => s.version); // re-render toolbar/menu on any selection change

  const list = useCallback(
    async (dir: string) => {
      setLoading(true);
      setError(null);
      try {
        setEntries(await adapter.list(dir));
        setCwd(dir);
        onCwdChange(dir);
      } catch (e) {
        setError(t('sftp.loadError', { reason: e instanceof Error ? e.message : String(e) }));
      } finally {
        setLoading(false);
      }
    },
    [adapter, onCwdChange, t],
  );

  // (Re)load home whenever the adapter identity changes (host switch / connect).
  useEffect(() => {
    let cancelled = false;
    setCwd(null);
    setEntries([]);
    void (async () => {
      try {
        const home = await adapter.homeDir();
        if (!cancelled) await list(home);
      } catch (e) {
        if (!cancelled) setError(t('sftp.loadError', { reason: e instanceof Error ? e.message : String(e) }));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapter]);

  // External refresh (a transfer/zip landed here).
  useEffect(() => {
    if (refreshKey > 0 && cwd != null) void list(cwd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  // Sorting is client-side over the in-memory listing; `sorted` is the single
  // source of order for rendering, shift-ranges, keyboard indices and the
  // virtualizer, so they can never disagree.
  const sorted = useMemo(() => sortEntries(entries, sort), [entries, sort]);
  const order = useMemo(() => sorted.map((e) => e.path), [sorted]);
  const selectedItems = useCallback(
    (fallback?: FsItem): FsItem[] => {
      const set = useSel.getState().selected;
      const chosen = sorted.filter((e) => set.has(e.path));
      return chosen.length ? chosen : fallback ? [fallback] : [];
    },
    [sorted, useSel],
  );

  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });
  const { onDragOver: onDragScroll, stopDragScroll } = usePaneDragScroll(scrollEl);

  // Entering a directory must land at the top; without this the virtualizer
  // keeps the previous scroll offset and the new listing opens mid-list.
  useEffect(() => {
    virtualizer.scrollToOffset(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd]);

  const actions = usePaneActions({ adapter, useSel, cwd, refresh: list, otherKind, otherCwd, onTransfer, onZip, onExtract, t });
  const extra = usePaneExtraActions({ adapter, cwd, refresh: list, createFile, t });
  const menu = usePaneMenu({ adapter, useSel, selectedItems, actions, extra, onOpenFile, onEditPermissions, refresh: () => cwd != null && void list(cwd), t });

  const onRowClick = useCallback(
    (e: MouseEvent, item: FsItem) => {
      const s = useSel.getState();
      if (e.shiftKey) s.selectRange(item.path, order);
      else if (e.ctrlKey || e.metaKey) s.toggle(item.path);
      else s.setSingle(item.path);
    },
    [order, useSel],
  );

  const onOpen = useCallback((item: FsItem) => (item.type === 'dir' ? void list(item.path) : onOpenFile?.(item)), [list, onOpenFile]);

  const onDragStart = useCallback(
    (e: DragEvent, item: FsItem) => {
      const set = useSel.getState().selected;
      // Payload is serialized into dataTransfer (see pane-dnd.ts), so a source
      // row unmounting mid-drag — which virtualization makes routine — is fine.
      const items = set.has(item.path) ? sorted.filter((x) => set.has(x.path)) : [item];
      setPanePayload(e, { fromKind: adapter.kind, items });
    },
    [sorted, useSel, adapter.kind],
  );

  const onKeyDown = usePaneKeyboard({
    useSel,
    entries: sorted,
    order,
    pageSize: () => Math.max(1, Math.floor((scrollEl?.clientHeight ?? 0) / ROW_HEIGHT)),
    scrollToIndex: (i) => virtualizer.scrollToIndex(i, { align: 'auto' }),
    onOpen,
    onParent: () => cwd != null && !atRootOf(adapter, cwd) && void list(adapter.parentDir(cwd)),
    onRemove: (items) => void actions.doRemove(items),
    onRename: (item) => void actions.doRename(item),
    onRefresh: () => cwd != null && void list(cwd),
    selectedItems,
  });

  const dropInto = useCallback(
    (e: DragEvent, dir: string) => {
      setDropActive(false);
      const p = readPanePayload(e);
      if (!p || p.fromKind === adapter.kind) return;
      e.preventDefault();
      e.stopPropagation();
      onTransfer(p.fromKind, adapter.kind, dir, p.items);
    },
    [adapter.kind, onTransfer],
  );

  const atRoot = cwd != null && atRootOf(adapter, cwd);

  return (
    <div className="h-full flex flex-col min-h-0">
      <FilePaneHeader
        adapter={adapter}
        cwd={cwd}
        atRoot={atRoot}
        loading={loading}
        error={error}
        columns={columns}
        columnWidths={columnWidths}
        sort={sort}
        onNavigate={(dir) => void list(dir)}
        onRefresh={() => cwd != null && void list(cwd)}
        onNewFolder={() => void actions.doMkdir()}
        onTransferSelected={() => actions.doTransfer(selectedItems())}
        onToggleColumn={onToggleColumn}
        onColumnWidthChange={onColumnWidthChange}
        onSort={onSort}
      />

      {/* Virtualized unconditionally: one render path avoids the
          "works at 39 rows, breaks at 41" class of bug, and a real listing
          (node_modules, /usr/bin) used to mount thousands of DOM rows. */}
      <div
        ref={setScrollEl}
        tabIndex={0}
        role="listbox"
        aria-multiselectable
        aria-label={adapter.label}
        onKeyDown={onKeyDown}
        className={cn(
          'flex-1 min-h-0 overflow-y-auto outline-none [scrollbar-gutter:stable]',
          dropActive && 'ring-2 ring-inset ring-primary/60',
        )}
        onContextMenu={menu.onEmptyContext}
        onDragOver={(e) => {
          if (!hasPanePayload(e)) return;
          e.preventDefault();
          setDropActive(true);
          // An off-screen row has no DOM node to drop onto, so the pane has to
          // scroll itself while the cursor sits near an edge.
          onDragScroll(e);
        }}
        onDragLeave={() => {
          setDropActive(false);
          stopDragScroll();
        }}
        onDrop={(e) => {
          stopDragScroll();
          if (cwd != null) dropInto(e, cwd);
        }}
      >
        {sorted.length === 0 && !loading && (
          <div className="grid place-items-center h-full text-xs text-muted-foreground">{t('sftp.empty')}</div>
        )}
        {sorted.length > 0 && (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const e = sorted[vi.index];
              return (
                <div
                  key={e.path}
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}
                >
                  <FilePaneRow
                    item={e}
                    useSel={useSel}
                    busy={actions.busyPath === e.path}
                    columns={columns}
                    columnWidths={columnWidths}
                    onClick={onRowClick}
                    onOpen={onOpen}
                    onContext={menu.onRowContext}
                    onDragStart={onDragStart}
                    onDropInto={(ev, item) => dropInto(ev, item.path)}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
      {menu.Menu}
    </div>
  );
}

/** True when `cwd` is the adapter's root (parentDir clamps there). */
function atRootOf(adapter: FsAdapter, cwd: string): boolean {
  return adapter.parentDir(cwd) === cwd;
}


