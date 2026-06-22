/**
 * One request row: VERB · PATH on top, name below, a status dot colored by the
 * last result, an optional selection checkbox (bulk mode), drag-to-move, and a
 * right-click context menu (open / duplicate / move to folder / delete).
 */
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Circle, Trash2, Copy, ExternalLink, FolderInput, Plus } from 'lucide-react';
import { useContextMenu, type ContextMenuItem } from '../../../components/ui/context-menu.js';
import { cn } from '../../../lib/utils.js';
import type { ApiRequest } from '../types.js';
import { METHOD_COLOR, statusColor, pathOnly } from './row-format.js';

interface Props {
  request: ApiRequest;
  active: boolean;
  inFolder: boolean;
  folders: string[];
  selectMode: boolean;
  selected: boolean;
  onOpen: (id: number) => void;
  onToggleSelect: (id: number) => void;
  onDuplicate: (id: number) => void;
  onMove: (id: number, folder: string | null) => void;
  onMoveToNew: (id: number) => void;
  onDelete: (id: number) => void;
  onDragStart: (id: number) => void;
  onDragEnd: () => void;
}

function RequestRowImpl(p: Props) {
  const { t } = useTranslation('apiClient');
  const r = p.request;
  const ran = r.last_status != null;
  const tone = statusColor(r.last_status);
  const dotTitle = ran ? t('row.lastStatus', { status: r.last_status }) : (r.verified ? t('row.verifiedNotRun') : t('row.notSent'));

  // Rebuild the menu only when the row's folder, the folder list, or a handler
  // changes — not on every parent re-render (typing/drag re-renders the list).
  const items = useMemo<ContextMenuItem[]>(() => [
    { id: 'open', label: t('row.open'), icon: ExternalLink, onSelect: () => p.onOpen(r.id) },
    { id: 'dup', label: t('row.duplicate'), icon: Copy, onSelect: () => p.onDuplicate(r.id) },
    {
      id: 'move', label: t('row.moveTo'), icon: FolderInput, separatorBefore: true,
      submenu: [
        { id: 'move-top', label: t('row.topLevel'), onSelect: () => p.onMove(r.id, null) },
        ...p.folders.filter((f) => f !== (r.folder ?? '')).map((f) => ({ id: `move-${f}`, label: f, onSelect: () => p.onMove(r.id, f) })),
        { id: 'move-new', label: t('row.newFolder'), icon: Plus, separatorBefore: true, onSelect: () => p.onMoveToNew(r.id) },
      ],
    },
    { id: 'del', label: t('row.delete'), icon: Trash2, destructive: true, separatorBefore: true, onSelect: () => p.onDelete(r.id) },
  ], [r.id, r.folder, p.folders, p.onOpen, p.onDuplicate, p.onMove, p.onMoveToNew, p.onDelete, t]);
  const { triggerProps, Menu } = useContextMenu(items);

  return (
    <div
      draggable={!p.selectMode}
      onDragStart={() => p.onDragStart(r.id)}
      onDragEnd={p.onDragEnd}
      onClick={() => (p.selectMode ? p.onToggleSelect(r.id) : p.onOpen(r.id))}
      {...triggerProps}
      className={cn(
        'group flex items-start gap-2 py-1.5 pr-2 text-xs cursor-pointer border-b border-border/40',
        p.inFolder ? 'pl-6' : 'pl-2',
        p.active && !p.selectMode ? 'bg-muted' : p.selected ? 'bg-primary/10' : 'hover:bg-muted/50',
      )}
    >
      {p.selectMode ? (
        <input type="checkbox" checked={p.selected} onChange={() => p.onToggleSelect(r.id)} onClick={(e) => e.stopPropagation()} className="h-3.5 w-3.5 mt-0.5 accent-primary shrink-0" />
      ) : (
        <span title={dotTitle} className="mt-0.5 flex shrink-0">
          {r.verified
            ? <CheckCircle2 className={cn('h-3.5 w-3.5', ran ? tone : 'text-emerald-500')} />
            : <Circle className={cn('h-3.5 w-3.5', ran ? cn(tone, 'fill-current') : 'text-muted-foreground/30')} />}
        </span>
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={cn('font-mono font-semibold text-[10px] w-10 shrink-0', METHOD_COLOR[r.method] ?? '')}>{r.method}</span>
          <span className="font-mono truncate text-muted-foreground">{pathOnly(r.path_template)}</span>
          {r.last_status != null && <span className={cn('ml-auto font-mono text-[10px] shrink-0', tone)}>{r.last_status}</span>}
        </div>
        {r.name && r.name !== pathOnly(r.path_template) && <div className="truncate text-foreground/80 mt-0.5">{r.name}</div>}
      </div>
      {!p.selectMode && (
        <button className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-500 mt-0.5"
          title={t('row.deleteRequest')} onClick={(e) => { e.stopPropagation(); p.onDelete(r.id); }}>
          <Trash2 className="h-3 w-3" />
        </button>
      )}
      {Menu}
    </div>
  );
}

/** Memoized: with stable props (parent memoizes folders + callbacks), only rows
 *  whose request/active/selected/inFolder actually change re-render — so typing
 *  in an input or dragging no longer re-renders the whole list. */
export const RequestRow = memo(RequestRowImpl);
