/**
 * Horizontal frame timeline: thumb per frame (FrameCell), click = select,
 * HTML5 drag to reorder, per-frame duration/delete/duplicate/replace/edit
 * actions. Version rows dragged from the inspector drop ON a cell (replace
 * that frame) or on the trailing dashed "+" zone (append a frame — also
 * clickable as a version picker). Every list edit calls onEdit with the FULL
 * new list — the parent auto-commits it (PATCH frames) debounced 500ms. The
 * header hosts the "Align" registration menu (autoCrop + re-anchor every
 * frame server-side).
 */
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlignVerticalJustifyEnd, ClipboardPaste, Copy, FlipHorizontal2, Loader2, Plus } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '../../../components/ui/dropdown-menu.js';
import { toast } from '../../../components/ui/prompt-dialog.js';
import type { AssetVersion } from '../types.js';
import { hasVersionDragData, readVersionDragData, type SpriteVersionDragPayload } from '../version-drag.js';
import type { AnchorX, AnchorY, AnimFrame } from './api-anim.js';
import { FrameCell } from './FrameCell.js';
import { VersionPickerPopover } from './VersionPickerPopover.js';

/** 4 anchor presets — bottom-center first (feet-on-ground for characters). */
const ALIGN_PRESETS: Array<{ key: string; anchorX: AnchorX; anchorY: AnchorY }> = [
  { key: 'bottomCenter', anchorX: 'center', anchorY: 'bottom' },
  { key: 'center', anchorX: 'center', anchorY: 'middle' },
  { key: 'bottomLeft', anchorX: 'left', anchorY: 'bottom' },
  { key: 'bottomRight', anchorX: 'right', anchorY: 'bottom' },
];

export function TimelineStrip({
  projectId, assetId, frames, fps, selectedIndex, aligning, versionById,
  onSelect, onEdit, onAlign, onEditVersion, onReverse, onCopy, onPaste,
}: {
  projectId: number;
  assetId: number;
  frames: AnimFrame[];
  fps: number;
  selectedIndex: number;
  /** True while the align route runs — the menu is disabled meanwhile. */
  aligning: boolean;
  /** versionId → version row, for per-frame provenance titles. */
  versionById: Map<number, AssetVersion>;
  onSelect: (i: number) => void;
  /** Full new list after any reorder/delete/duration/replace/duplicate edit. */
  onEdit: (next: AnimFrame[]) => void;
  /** Re-anchor ALL frames on their own canvas (server-side, new versions). */
  onAlign: (anchorX: AnchorX, anchorY: AnchorY) => void;
  /** Open a frame's version in the editor (Edit action). */
  onEditVersion?: (versionId: number) => void;
  /** Frame ops (also on the keyboard) — reverse all / copy+paste selected. */
  onReverse?: () => void;
  onCopy?: () => void;
  onPaste?: () => void;
}) {
  const { t } = useTranslation('spriteStudio');
  const dragFrom = useRef<number | null>(null);
  const [tailOver, setTailOver] = useState(false);
  const defaultMs = Math.round(1000 / Math.max(1, fps));

  const reindex = (list: AnimFrame[]): AnimFrame[] => list.map((f, i) => ({ ...f, frameIndex: i }));

  const onDropOn = (to: number) => {
    const from = dragFrom.current;
    dragFrom.current = null;
    if (from == null || from === to) return;
    const next = [...frames];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onEdit(reindex(next));
    onSelect(to);
  };

  const onDuration = (i: number, ms: number | null) => {
    onEdit(frames.map((f, k) => (k === i ? { ...f, durationMs: ms } : f)));
  };

  const onDelete = (i: number) => {
    onEdit(reindex(frames.filter((_, k) => k !== i)));
    if (selectedIndex >= frames.length - 1) onSelect(Math.max(0, frames.length - 2));
  };

  /** Insert a copy right after the source frame (same version + duration). */
  const onDuplicate = (i: number) => {
    const next = [...frames];
    next.splice(i + 1, 0, { ...frames[i] });
    onEdit(reindex(next));
    onSelect(i + 1);
  };

  /** Repoint one frame at another version of the same asset. */
  const onReplace = (i: number, versionId: number) => {
    onEdit(frames.map((f, k) => (k === i ? { ...f, versionId } : f)));
  };

  /** Append a frame pointing at a version (server assigns the row id). */
  const appendVersion = (versionId: number) => {
    onEdit(reindex([...frames, { id: -1, frameIndex: frames.length, versionId, durationMs: null }]));
    onSelect(frames.length);
  };

  /** Version dropped on a cell (at) or the tail (null) — same-asset only. */
  const onDropVersion = (at: number | null, payload: SpriteVersionDragPayload) => {
    if (payload.assetId !== assetId) {
      toast.error(t('animate.timeline.dropWrongAsset'));
      return;
    }
    if (at == null) appendVersion(payload.versionId);
    else onReplace(at, payload.versionId);
  };

  return (
    <div className="shrink-0 border-t pt-2">
      <div className="mb-1 flex items-center gap-2 text-[10px] text-muted-foreground">
        <span className="font-medium uppercase tracking-wider">{t('animate.timeline.title')}</span>
        {frames.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                className="h-5 gap-1 px-1.5 text-[10px]"
                disabled={aligning}
                title={t('animate.align.hint')}
              >
                {aligning
                  ? <Loader2 className="h-2.5 w-2.5 animate-spin" />
                  : <AlignVerticalJustifyEnd className="h-2.5 w-2.5" />}
                {aligning ? t('animate.align.aligning') : t('animate.align.button')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {ALIGN_PRESETS.map((p) => (
                <DropdownMenuItem key={p.key} className="text-xs" onClick={() => onAlign(p.anchorX, p.anchorY)}>
                  {t(`animate.align.${p.key}`)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {frames.length > 1 && onReverse && (
          <Button size="sm" variant="ghost" className="h-5 w-5 p-0" title={t('animate.timeline.reverse')} onClick={onReverse}>
            <FlipHorizontal2 className="h-2.5 w-2.5" />
          </Button>
        )}
        {frames.length > 0 && onCopy && (
          <Button size="sm" variant="ghost" className="h-5 w-5 p-0" title={t('animate.timeline.copyFrame')} onClick={onCopy}>
            <Copy className="h-2.5 w-2.5" />
          </Button>
        )}
        {onPaste && (
          <Button size="sm" variant="ghost" className="h-5 w-5 p-0" title={t('animate.timeline.pasteFrame')} onClick={onPaste}>
            <ClipboardPaste className="h-2.5 w-2.5" />
          </Button>
        )}
        <span className="ml-auto">{t('animate.timeline.autoSaved')}</span>
      </div>
      <div className="flex items-stretch gap-1.5 overflow-x-auto pb-1">
        {frames.map((f, i) => (
          <FrameCell
            // Duplicated frames share a versionId — the index keeps keys unique.
            key={`${i}:${f.versionId}`}
            projectId={projectId}
            assetId={assetId}
            frame={f}
            index={i}
            selected={i === selectedIndex}
            defaultMs={defaultMs}
            version={versionById.get(f.versionId)}
            onSelect={onSelect}
            onDuration={onDuration}
            onDelete={onDelete}
            onDuplicate={onDuplicate}
            onReplace={onReplace}
            onEditVersion={onEditVersion}
            onDragStart={(idx) => { dragFrom.current = idx; }}
            onDropOn={onDropOn}
            onDropVersion={(i2, payload) => onDropVersion(i2, payload)}
          />
        ))}
        {/* Tail "+" zone: click = version picker, drop a version = append. */}
        <VersionPickerPopover
          projectId={projectId}
          assetId={assetId}
          currentVersionId={null}
          title={t('animate.timeline.addTitle')}
          onPick={appendVersion}
        >
          <button
            type="button"
            className={`flex min-h-24 w-16 shrink-0 flex-col items-center justify-center gap-1 rounded border border-dashed text-muted-foreground transition-colors hover:border-primary/60 hover:text-foreground ${
              tailOver ? 'border-primary bg-primary/15 text-foreground' : 'border-border'
            }`}
            title={t('animate.timeline.addFrameHint')}
            onDragOver={(e) => {
              if (!hasVersionDragData(e.dataTransfer)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
              if (!tailOver) setTailOver(true);
            }}
            onDragLeave={() => setTailOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setTailOver(false);
              const payload = readVersionDragData(e.dataTransfer);
              if (payload) onDropVersion(null, payload);
            }}
          >
            <Plus className="h-4 w-4" />
            <span className="px-1 text-center text-[9px] leading-tight">{t('animate.timeline.addFrame')}</span>
          </button>
        </VersionPickerPopover>
      </div>
    </div>
  );
}
