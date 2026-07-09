/**
 * Generic file pane — the same component drives both sides; only its `adapter`
 * differs (local project files vs remote SFTP). Owns its cwd/listing and
 * Ctrl/Shift multi-select; delegates the toolbar/menu actions to
 * `usePaneActions` and the right-click menu to `usePaneMenu`, and supports
 * cross-pane drag & drop.
 */
import { useCallback, useEffect, useMemo, useState, type DragEvent, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUp, Check, Columns2, Download, FolderPlus, Loader2, RefreshCw, Upload } from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover.js';
import { FilePaneRow } from './FilePaneRow.js';
import { hasPanePayload, readPanePayload, setPanePayload } from './pane-dnd.js';
import { usePaneActions } from './use-pane-actions.js';
import { usePaneMenu } from './use-pane-menu.js';
import { COLUMNS, type ColumnId, type ColumnVisibility } from './column-config.js';
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
  onZip: (cwd: string, names: string[]) => Promise<boolean> | void;
  onExtract: (cwd: string, name: string) => Promise<boolean> | void;
  /** Which metadata columns are visible (shared by both panes). */
  columns: ColumnVisibility;
  onToggleColumn: (id: ColumnId) => void;
}

export function FilePane(props: FilePaneProps) {
  const { adapter, useSel, otherKind, otherCwd, refreshKey, onCwdChange, onTransfer, onOpenFile, onZip, onExtract, columns, onToggleColumn } = props;
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

  const order = useMemo(() => entries.map((e) => e.path), [entries]);
  const selectedItems = useCallback(
    (fallback?: FsItem): FsItem[] => {
      const set = useSel.getState().selected;
      const chosen = entries.filter((e) => set.has(e.path));
      return chosen.length ? chosen : fallback ? [fallback] : [];
    },
    [entries, useSel],
  );

  const actions = usePaneActions({ adapter, useSel, cwd, refresh: list, otherKind, otherCwd, onTransfer, onZip, onExtract, t });
  const menu = usePaneMenu({ adapter, useSel, selectedItems, actions, onOpenFile, refresh: () => cwd != null && void list(cwd), t });

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
      const items = set.has(item.path) ? entries.filter((x) => set.has(x.path)) : [item];
      setPanePayload(e, { fromKind: adapter.kind, items });
    },
    [entries, useSel, adapter.kind],
  );

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

  const atRoot = cwd != null && adapter.parentDir(cwd) === cwd;
  const iconBtn = 'rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-40';
  const transferLabel = adapter.kind === 'local' ? t('files.toRemote') : t('files.toLocal');
  const TransferIcon = adapter.kind === 'local' ? Upload : Download;

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="h-8 shrink-0 border-b flex items-center gap-1 px-2">
        <span className="text-[11px] font-medium truncate max-w-[40%]" title={adapter.label}>{adapter.label}</span>
        <button type="button" aria-label={t('sftp.up')} className={iconBtn} disabled={cwd == null || atRoot} onClick={() => cwd != null && void list(adapter.parentDir(cwd))}>
          <ArrowUp className="h-3.5 w-3.5" />
        </button>
        <button type="button" aria-label={t('sftp.refresh')} className={iconBtn} disabled={cwd == null} onClick={() => cwd != null && void list(cwd)}>
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
        <button type="button" aria-label={t('sftp.newFolder')} className={iconBtn} disabled={cwd == null} onClick={() => void actions.doMkdir()}>
          <FolderPlus className="h-3.5 w-3.5" />
        </button>
        <button type="button" aria-label={transferLabel} title={transferLabel} className={iconBtn} onClick={() => actions.doTransfer(selectedItems())}>
          <TransferIcon className="h-3.5 w-3.5" />
        </button>
        <span className="ml-1 truncate font-mono text-[10px] text-muted-foreground flex-1" title={cwd ?? ''}>{cwd || '/'}</span>
        {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground shrink-0" />}
        <Popover>
          <PopoverTrigger asChild>
            <button type="button" aria-label={t('sftp.columnsToggle')} title={t('sftp.columnsToggle')} className={iconBtn}>
              <Columns2 className="h-3.5 w-3.5" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-44 p-1">
            <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{t('sftp.columnsTitle')}</p>
            {COLUMNS.map((col) => (
              <button
                key={col.id}
                type="button"
                role="menuitemcheckbox"
                aria-checked={columns[col.id]}
                onClick={() => onToggleColumn(col.id)}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent"
              >
                <span className="w-4 flex items-center justify-center">
                  {columns[col.id] && <Check className="h-3 w-3" />}
                </span>
                {t(`sftp.columns.${col.labelKey}`)}
              </button>
            ))}
          </PopoverContent>
        </Popover>
      </div>

      {error && <div className="px-2 py-1 text-[10px] text-red-400 border-b bg-red-500/10 shrink-0">{error}</div>}

      {/* Column header — mirrors the row layout so widths align. The Name
          column flexes (flex-1); the others use the same fixed widths as
          FilePaneRow so header and cells stay in lockstep. */}
      <div className="flex items-center gap-2 px-3 h-6 shrink-0 border-b bg-muted/40 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        <span className="w-3.5 shrink-0" />
        <span className="flex-1 truncate">{t('sftp.columns.name')}</span>
        {columns.size && <span className="shrink-0 w-16 text-right">{t('sftp.columns.size')}</span>}
        {columns.modified && <span className="shrink-0 w-28 text-right">{t('sftp.columns.modified')}</span>}
        {columns.permissions && <span className="shrink-0 w-24 text-right">{t('sftp.columns.permissions')}</span>}
      </div>

      <div
        className={cn('flex-1 min-h-0 overflow-y-auto', dropActive && 'ring-2 ring-inset ring-primary/60')}
        onContextMenu={menu.onEmptyContext}
        onDragOver={(e) => {
          if (hasPanePayload(e)) {
            e.preventDefault();
            setDropActive(true);
          }
        }}
        onDragLeave={() => setDropActive(false)}
        onDrop={(e) => cwd != null && dropInto(e, cwd)}
      >
        {entries.length === 0 && !loading && (
          <div className="grid place-items-center h-full text-xs text-muted-foreground">{t('sftp.empty')}</div>
        )}
        {entries.map((e) => (
          <FilePaneRow
            key={e.path}
            item={e}
            useSel={useSel}
            busy={actions.busyPath === e.path}
            columns={columns}
            onClick={onRowClick}
            onOpen={onOpen}
            onContext={menu.onRowContext}
            onDragStart={onDragStart}
            onDropInto={(ev, item) => dropInto(ev, item.path)}
          />
        ))}
      </div>
      {menu.Menu}
    </div>
  );
}
