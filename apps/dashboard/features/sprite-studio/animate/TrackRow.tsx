/**
 * One timeline track row: TrackHeader gutter + a cell per grid column.
 * Filled cells reuse FrameCell (duration input only on the Base track —
 * shared time grid); empty cells are dashed placeholders (click = version
 * picker, drop = fill). Drag semantics (D6): Base-track drag reorders the
 * WHOLE column; overlay drag moves that single cell. Hidden tracks render
 * at half opacity.
 */
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '../../../components/ui/prompt-dialog.js';
import { cn } from '../../../lib/utils.js';
import type { AssetVersion } from '../types.js';
import type { SpriteVersionDragPayload } from '../version-drag.js';
import { hasVersionDragData, readVersionDragData } from '../version-drag.js';
import type { AnimFrame, TrackMeta } from './api-anim.js';
import { FrameCell } from './FrameCell.js';
import { TrackHeader } from './TrackHeader.js';
import { VersionPickerPopover } from './VersionPickerPopover.js';

export interface TrackRowProps {
  projectId: number;
  assetId: number;
  track: TrackMeta;
  cells: Array<AnimFrame | null>;
  activeTrack: number;
  selectedIndex: number;
  fps: number;
  versionById: Map<number, AssetVersion>;
  onActivateTrack: (id: number) => void;
  onRenameTrack: (id: number, name: string) => void;
  onToggleVisible: (id: number, visible: boolean) => void;
  onDeleteTrack: (id: number) => void;
  onSelect: (track: number, col: number) => void;
  onSetCell: (track: number, col: number, versionId: number) => void;
  onClearCell: (track: number, col: number) => void;
  onDuration: (col: number, ms: number | null) => void;
  onColumnDrag: (from: number, to: number) => void;
  onCellDrag: (track: number, from: number, to: number) => void;
  onDuplicateColumn: (col: number) => void;
  onEditVersion?: (versionId: number) => void;
  dragFrom: React.MutableRefObject<{ track: number; col: number } | null>;
}

export function TrackRow(p: TrackRowProps) {
  const { t } = useTranslation('spriteStudio');
  const isBase = p.track.id === 0;
  const trackId = p.track.id;
  const { onSelect, onClearCell, onSetCell, onColumnDrag, onCellDrag, dragFrom, assetId } = p;

  // Per-cell handlers are useCallback'd so FrameCell's memo actually skips:
  // fresh inline closures re-rendered EVERY cell of every track on each panel
  // render (scrub pointermove, SSE job bumps during a generation). dragFrom is
  // a ref, read at call time — safe as a dep.

  // A FRAME drag landed on column `col` of this row (D6 semantics).
  const onFrameDrop = useCallback((col: number) => {
    const from = dragFrom.current;
    dragFrom.current = null;
    if (!from) return;
    if (from.track === 0 && trackId === 0) onColumnDrag(from.col, col);
    else if (from.track === trackId) onCellDrag(trackId, from.col, col);
  }, [dragFrom, trackId, onColumnDrag, onCellDrag]);

  const onCellSelect = useCallback((i: number) => onSelect(trackId, i), [onSelect, trackId]);
  const onCellDelete = useCallback((i: number) => onClearCell(trackId, i), [onClearCell, trackId]);
  const onCellReplace = useCallback(
    (i: number, versionId: number) => onSetCell(trackId, i, versionId),
    [onSetCell, trackId],
  );
  const onCellDragStart = useCallback((i: number) => {
    dragFrom.current = { track: trackId, col: i };
  }, [dragFrom, trackId]);
  const onCellDropVersion = useCallback((i: number, payload: SpriteVersionDragPayload) => {
    if (payload.assetId !== assetId) { toast.error(t('animate.timeline.dropWrongAsset')); return; }
    onSetCell(trackId, i, payload.versionId);
  }, [assetId, onSetCell, trackId, t]);

  // Empty-placeholder drop: real DOM event — version payload OR frame move.
  const onEmptyDrop = (col: number, e: React.DragEvent) => {
    e.preventDefault();
    const payload = readVersionDragData(e.dataTransfer);
    if (payload) {
      if (payload.assetId !== assetId) { toast.error(t('animate.timeline.dropWrongAsset')); return; }
      onSetCell(trackId, col, payload.versionId);
      return;
    }
    onFrameDrop(col);
  };

  return (
    <div className={cn('group/trackrow flex items-stretch gap-1.5', !p.track.visible && 'opacity-50')}>
      <TrackHeader
        track={p.track}
        active={p.activeTrack === p.track.id}
        onActivate={p.onActivateTrack}
        onRename={p.onRenameTrack}
        onToggleVisible={p.onToggleVisible}
        onDelete={p.onDeleteTrack}
      />
      {p.cells.map((cell, col) =>
        cell ? (
          <FrameCell
            key={`${p.track.id}:${col}:${cell.versionId}`}
            projectId={p.projectId}
            assetId={p.assetId}
            frame={cell}
            index={col}
            selected={p.activeTrack === p.track.id && p.selectedIndex === col}
            defaultMs={Math.round(1000 / Math.max(1, p.fps))}
            version={p.versionById.get(cell.versionId)}
            showDuration={isBase}
            onSelect={onCellSelect}
            onDuration={p.onDuration}
            onDelete={onCellDelete}
            onDuplicate={p.onDuplicateColumn}
            onReplace={onCellReplace}
            onEditVersion={p.onEditVersion}
            onDragStart={onCellDragStart}
            onDropOn={onFrameDrop}
            onDropVersion={onCellDropVersion}
          />
        ) : (
          <VersionPickerPopover
            key={`${p.track.id}:${col}:empty`}
            projectId={p.projectId}
            assetId={p.assetId}
            currentVersionId={null}
            title={t('animate.tracks.fillCell')}
            onPick={(versionId) => p.onSetCell(p.track.id, col, versionId)}
          >
            <button
              type="button"
              title={t('animate.tracks.emptyCell')}
              className="flex min-h-24 w-16 shrink-0 items-center justify-center rounded border border-dashed border-border/60 text-[9px] text-muted-foreground/50 transition-colors hover:border-primary/50 hover:text-muted-foreground"
              onClick={() => p.onSelect(p.track.id, col)}
              onDragOver={(e) => { if (hasVersionDragData(e.dataTransfer) || p.dragFrom.current) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }}
              onDrop={(e) => onEmptyDrop(col, e)}
            >
              {col + 1}
            </button>
          </VersionPickerPopover>
        ),
      )}
    </div>
  );
}
