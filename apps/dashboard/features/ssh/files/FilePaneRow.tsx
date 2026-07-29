/**
 * One row in a pane. Subscribes to just its own selection bit so a selection
 * change only re-renders the rows entering/leaving the selection. Draggable
 * (source of a cross-pane transfer); a directory row is also a drop target that
 * transfers into that folder.
 */
import type { DragEvent, MouseEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { FileIcon, FolderIcon } from '../../../components/FileIcon.js';
import { cn } from '../../../lib/utils.js';
import { fmtBytes, fmtDate, fmtMode, fmtOwner, type FsItem } from './fs-adapter.js';
import { hasPanePayload } from './pane-dnd.js';
import type { PaneSelectionStore } from './pane-selection.js';
import { ROW_HEIGHT, type ColumnVisibility, type ColumnWidths } from './column-config.js';

interface RowProps {
  item: FsItem;
  useSel: PaneSelectionStore;
  busy: boolean;
  columns: ColumnVisibility;
  columnWidths: ColumnWidths;
  onClick: (e: MouseEvent, item: FsItem) => void;
  onOpen: (item: FsItem) => void;
  onContext: (e: MouseEvent, item: FsItem) => void;
  onDragStart: (e: DragEvent, item: FsItem) => void;
  onDropInto: (e: DragEvent, item: FsItem) => void;
}

export function FilePaneRow({ item, useSel, busy, columns, columnWidths, onClick, onOpen, onContext, onDragStart, onDropInto }: RowProps) {
  const selected = useSel((s) => s.selected.has(item.path));
  const isDir = item.type === 'dir';
  const size = isDir ? '' : fmtBytes(item.size);
  const modified = fmtDate(item.mtime);
  const permissions = fmtMode(item.mode, item.type);
  // Falls back to the raw uid/gid when the host's passwd/group couldn't be read
  // — same as every SFTP client. Blank on the local side, which has neither.
  const owner = fmtOwner(item.owner, item.uid);
  const group = fmtOwner(item.group, item.gid);
  return (
    <div
      role="option"
      aria-selected={selected}
      draggable
      onDragStart={(e) => onDragStart(e, item)}
      onDragOver={isDir ? (e) => hasPanePayload(e) && e.preventDefault() : undefined}
      onDrop={isDir ? (e) => onDropInto(e, item) : undefined}
      onClick={(e) => onClick(e, item)}
      onDoubleClick={() => onOpen(item)}
      onContextMenu={(e) => onContext(e, item)}
      // Explicit height (not implied by py-1) — the pane is virtualized and
      // `estimateSize` must match exactly or rows drift from the scrollbar.
      style={{ height: ROW_HEIGHT }}
      className={cn(
        'flex min-w-0 items-center gap-2 px-3 text-xs cursor-default select-none',
        selected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
      )}
    >
      {isDir ? (
        <FolderIcon name={item.name} expanded={false} className="h-3.5 w-3.5" />
      ) : (
        <FileIcon path={item.name} className="h-3.5 w-3.5" />
      )}
      <span className="min-w-0 truncate whitespace-nowrap flex-1" title={item.name}>{item.name}</span>
      {columns.size && (
        <span className="text-muted-foreground tabular-nums shrink-0 truncate whitespace-nowrap text-right" style={{ width: columnWidths.size }} title={size}>{size}</span>
      )}
      {columns.modified && (
        <span className="text-muted-foreground tabular-nums shrink-0 truncate whitespace-nowrap text-right" style={{ width: columnWidths.modified }} title={modified}>{modified}</span>
      )}
      {columns.owner && (
        <span className="text-muted-foreground shrink-0 truncate whitespace-nowrap text-right" style={{ width: columnWidths.owner }} title={owner}>{owner}</span>
      )}
      {columns.group && (
        <span className="text-muted-foreground shrink-0 truncate whitespace-nowrap text-right" style={{ width: columnWidths.group }} title={group}>{group}</span>
      )}
      {columns.permissions && (
        <span className="text-muted-foreground font-mono shrink-0 truncate whitespace-nowrap text-right" style={{ width: columnWidths.permissions }} title={permissions}>{permissions}</span>
      )}
      {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground shrink-0" />}
    </div>
  );
}
