/**
 * Multi-track timeline (AE/Aseprite-style): one TrackRow per animation layer
 * (top row = highest layer; Base at the bottom), a shared column grid, and a
 * header with the Align/registration menu, column ops (reverse/copy/paste),
 * "+ layer" (≤4) and the tail "+" that appends a column on the ACTIVE track.
 * All cell/column edits flow up as flat-list transforms (timeline-model) —
 * the parent owns the draft + per-track debounced PATCH.
 */
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { AlignVerticalJustifyEnd, ClipboardPaste, Copy, FlipHorizontal2, Layers, Loader2, Plus } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '../../../components/ui/dropdown-menu.js';
import type { AssetVersion } from '../types.js';
import type { AlignScope, AnchorX, AnchorY, TrackMeta } from './api-anim.js';
import type { TimelineModel } from './timeline-model.js';
import { TrackRow } from './TrackRow.js';
import { VersionPickerPopover } from './VersionPickerPopover.js';

/** 4 anchor presets — bottom-center first (feet-on-ground for characters). */
const ALIGN_PRESETS: Array<{ key: string; anchorX: AnchorX; anchorY: AnchorY }> = [
  { key: 'bottomCenter', anchorX: 'center', anchorY: 'bottom' },
  { key: 'center', anchorX: 'center', anchorY: 'middle' },
  { key: 'bottomLeft', anchorX: 'left', anchorY: 'bottom' },
  { key: 'bottomRight', anchorX: 'right', anchorY: 'bottom' },
];

export function TimelineStrip({
  projectId, assetId, model, fps, activeTrack, selectedIndex, aligning, versionById,
  onSelect, onAlign, onEditVersion, onReverse, onCopy, onPaste,
  onSetCell, onClearCell, onDuration, onColumnDrag, onCellDrag, onDuplicateColumn,
  onActivateTrack, onAddTrack, onRenameTrack, onToggleVisible, onDeleteTrack, onAppend,
}: {
  projectId: number;
  assetId: string;
  model: TimelineModel;
  fps: number;
  activeTrack: number;
  selectedIndex: number;
  aligning: boolean;
  versionById: Map<string, AssetVersion>;
  onSelect: (track: number, col: number) => void;
  onAlign: (anchorX: AnchorX, anchorY: AnchorY, scope: AlignScope) => void;
  onEditVersion?: (versionId: string, frameIndex: number, track: number) => void;
  onReverse?: () => void;
  onCopy?: () => void;
  onPaste?: () => void;
  onSetCell: (track: number, col: number, versionId: string) => void;
  onClearCell: (track: number, col: number) => void;
  onDuration: (col: number, ms: number | null) => void;
  onColumnDrag: (from: number, to: number) => void;
  onCellDrag: (track: number, from: number, to: number) => void;
  onDuplicateColumn: (col: number) => void;
  onActivateTrack: (id: number) => void;
  onAddTrack: () => void;
  onRenameTrack: (id: number, name: string) => void;
  onToggleVisible: (id: number, visible: boolean) => void;
  onDeleteTrack: (id: number) => void;
  /** Append a version at column gridLen of the ACTIVE track. */
  onAppend: (versionId: string) => void;
}) {
  const { t } = useTranslation('spriteStudio');
  const dragFrom = useRef<{ track: number; col: number } | null>(null);
  const hasFrames = model.gridLen > 0;
  const hasCurrentBaseFrame = model.cellAt(0, selectedIndex) != null;
  // Top row = highest layer (AE-style); Base renders at the bottom.
  const rows: TrackMeta[] = [...model.tracks].sort((a, b) => b.id - a.id);

  return (
    <div className="shrink-0 border-t pt-2">
      <div className="mb-1 flex items-center gap-2 text-[10px] text-muted-foreground">
        <span className="font-medium uppercase tracking-wider">{t('animate.timeline.title')}</span>
        {hasFrames && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm" variant="outline" className="h-5 gap-1 px-1.5 text-[10px]"
                disabled={aligning} title={t('animate.align.hint')}
              >
                {aligning
                  ? <Loader2 className="h-2.5 w-2.5 animate-spin" />
                  : <AlignVerticalJustifyEnd className="h-2.5 w-2.5" />}
                {aligning ? t('animate.align.aligning') : t('animate.align.button')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-56">
              <DropdownMenuLabel className="text-[10px] uppercase tracking-wide">
                {t('animate.align.allFrames')}
              </DropdownMenuLabel>
              {ALIGN_PRESETS.map((p) => (
                <DropdownMenuItem key={`all-${p.key}`} className="text-xs" onClick={() => onAlign(p.anchorX, p.anchorY, 'all')}>
                  {t(`animate.align.${p.key}`)}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[10px] uppercase tracking-wide">
                {t('animate.align.currentFrame', { n: selectedIndex + 1 })}
              </DropdownMenuLabel>
              {ALIGN_PRESETS.map((p) => (
                <DropdownMenuItem
                  key={`current-${p.key}`}
                  className="text-xs"
                  disabled={!hasCurrentBaseFrame}
                  onClick={() => onAlign(p.anchorX, p.anchorY, 'current')}
                >
                  {t(`animate.align.${p.key}`)}
                </DropdownMenuItem>
              ))}
              {!hasCurrentBaseFrame && (
                <div className="px-2 py-1 text-[10px] text-muted-foreground">
                  {t('animate.align.noCurrentFrameHint')}
                </div>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {hasFrames && onReverse && (
          <Button size="sm" variant="ghost" className="h-5 w-5 p-0" title={t('animate.timeline.reverse')} onClick={onReverse}>
            <FlipHorizontal2 className="h-2.5 w-2.5" />
          </Button>
        )}
        {hasFrames && onCopy && (
          <Button size="sm" variant="ghost" className="h-5 w-5 p-0" title={t('animate.timeline.copyFrame')} onClick={onCopy}>
            <Copy className="h-2.5 w-2.5" />
          </Button>
        )}
        {onPaste && (
          <Button size="sm" variant="ghost" className="h-5 w-5 p-0" title={t('animate.timeline.pasteFrame')} onClick={onPaste}>
            <ClipboardPaste className="h-2.5 w-2.5" />
          </Button>
        )}
        <Button
          size="sm" variant="outline" className="h-5 gap-1 px-1.5 text-[10px]"
          disabled={model.tracks.length >= 4}
          title={t('animate.tracks.addHint')}
          onClick={onAddTrack}
        >
          <Layers className="h-2.5 w-2.5" /> {t('animate.tracks.add')}
        </Button>
        <span className="ml-auto">{t('animate.timeline.autoSaved')}</span>
      </div>
      <div className="flex flex-col gap-1 overflow-x-auto pb-1">
        {rows.map((track) => (
          <div key={track.id} className="flex items-stretch gap-1.5">
            <TrackRow
              projectId={projectId}
              assetId={assetId}
              track={track}
              cells={model.trackCells(track.id)}
              activeTrack={activeTrack}
              selectedIndex={selectedIndex}
              fps={fps}
              versionById={versionById}
              onActivateTrack={onActivateTrack}
              onRenameTrack={onRenameTrack}
              onToggleVisible={onToggleVisible}
              onDeleteTrack={onDeleteTrack}
              onSelect={onSelect}
              onSetCell={onSetCell}
              onClearCell={onClearCell}
              onDuration={onDuration}
              onColumnDrag={onColumnDrag}
              onCellDrag={onCellDrag}
              onDuplicateColumn={onDuplicateColumn}
              onEditVersion={onEditVersion}
              dragFrom={dragFrom}
            />
            {/* Tail "+" only on the ACTIVE track's row (click or drop appends). */}
            {track.id === activeTrack && (
              <VersionPickerPopover
                projectId={projectId}
                assetId={assetId}
                currentVersionId={null}
                title={t('animate.timeline.addTitle')}
                onPick={onAppend}
              >
                <button
                  type="button"
                  className="flex min-h-24 w-16 shrink-0 flex-col items-center justify-center gap-1 rounded border border-dashed text-muted-foreground transition-colors hover:border-primary/60 hover:text-foreground"
                  title={t('animate.timeline.addFrameHint')}
                >
                  <Plus className="h-4 w-4" />
                  <span className="px-1 text-center text-[9px] leading-tight">{t('animate.timeline.addFrame')}</span>
                </button>
              </VersionPickerPopover>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
