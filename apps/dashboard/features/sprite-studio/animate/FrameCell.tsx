/**
 * One cell of the TimelineStrip: thumb (click = select), delete overlay,
 * duration input, drag handle behavior — plus the per-frame action row
 * (hover-revealed, height reserved so cells never shift): Edit (opens the
 * frame's version in the editor as a copy), Replace (version-picker popover)
 * and Duplicate. Version rows dragged from the inspector can be DROPPED on a
 * cell to repoint the frame (highlighted while hovering). The cell's native
 * title is deep provenance — `#3 · v015 · generated · job #42 · 125ms` —
 * resolved from the versionById map. Memoized; native `title` only (perf
 * rule for strips).
 */
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeftRight, Copy, Pencil, X } from 'lucide-react';
import { versionThumbUrl } from '../api.js';
import type { AssetVersion } from '../types.js';
import { hasVersionDragData, readVersionDragData, type SpriteVersionDragPayload } from '../version-drag.js';
import type { AnimFrame } from './api-anim.js';
import { ReplaceVersionPopover } from './ReplaceVersionPopover.js';

export interface FrameCellProps {
  projectId: number;
  assetId: number;
  frame: AnimFrame;
  index: number;
  selected: boolean;
  defaultMs: number;
  /** The frame's version row (provenance title); undefined while loading. */
  version?: AssetVersion;
  /** Duration input only renders on the Base track (shared time grid). */
  showDuration?: boolean;
  onSelect: (i: number) => void;
  onDuration: (i: number, ms: number | null) => void;
  onDelete: (i: number) => void;
  onDuplicate: (i: number) => void;
  onReplace: (i: number, versionId: number) => void;
  /** When absent, the Edit action is hidden (no editor orchestration wired). */
  onEditVersion?: (versionId: number, frameIndex: number, track: number) => void;
  onDragStart: (i: number) => void;
  onDropOn: (i: number) => void;
  /** A version row was dropped ON this cell (replace; parent validates asset). */
  onDropVersion: (i: number, payload: SpriteVersionDragPayload) => void;
}

const actionCls =
  'rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground';

export const FrameCell = memo(function FrameCell({
  projectId, assetId, frame, index, selected, defaultMs, version, showDuration = true,
  onSelect, onDuration,
  onDelete, onDuplicate, onReplace, onEditVersion, onDragStart, onDropOn, onDropVersion,
}: FrameCellProps) {
  const { t } = useTranslation('spriteStudio');
  const [dropTarget, setDropTarget] = useState(false);

  // Deep provenance: which version renders here, where it came from, which
  // generation job produced it and how long it shows.
  const title = version
    ? [
        `#${index + 1}`,
        `v${String(version.version).padStart(3, '0')}`,
        t(`source.${version.source}`),
        version.jobId != null ? t('animate.timeline.jobRef', { id: version.jobId }) : null,
        `${frame.durationMs ?? defaultMs}ms`,
      ].filter(Boolean).join(' · ')
    : t('animate.timeline.dragHint');

  return (
    <div
      draggable
      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; onDragStart(index); }}
      onDragOver={(e) => {
        e.preventDefault();
        const isVersion = hasVersionDragData(e.dataTransfer);
        e.dataTransfer.dropEffect = isVersion ? 'copy' : 'move';
        if (isVersion !== dropTarget) setDropTarget(isVersion);
      }}
      onDragLeave={() => setDropTarget(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDropTarget(false);
        const payload = readVersionDragData(e.dataTransfer);
        if (payload) { onDropVersion(index, payload); return; }
        onDropOn(index);
      }}
      className={`group flex w-16 shrink-0 cursor-grab flex-col gap-1 rounded border p-1 ${
        dropTarget
          ? 'border-primary bg-primary/15 ring-1 ring-primary/60'
          : selected ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/40'
      }`}
      title={title}
    >
      <button
        type="button"
        className="relative aspect-square w-full overflow-hidden rounded-sm bg-muted/40"
        onClick={() => onSelect(index)}
        title={t('animate.timeline.frameAlt', { n: index + 1 })}
      >
        <img
          src={versionThumbUrl(projectId, frame.versionId, 64, version?.contentHash)}
          alt={t('animate.timeline.frameAlt', { n: index + 1 })}
          loading="lazy"
          className="h-full w-full object-contain"
          style={{ imageRendering: 'pixelated' }}
          draggable={false}
        />
        <span className="absolute left-0.5 top-0.5 rounded bg-background/80 px-1 text-[9px] tabular-nums">
          {index + 1}
        </span>
        <span
          role="button"
          tabIndex={-1}
          className="absolute right-0.5 top-0.5 hidden rounded bg-background/80 p-0.5 text-red-400 hover:bg-red-500/20 group-hover:block"
          title={t('animate.timeline.deleteFrame')}
          onClick={(e) => { e.stopPropagation(); onDelete(index); }}
        >
          <X className="h-2.5 w-2.5" />
        </span>
      </button>
      {/* Height reserved; buttons fade in on hover so the strip never reflows. */}
      <div className="flex h-4 items-center justify-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        {onEditVersion && (
          <button
            type="button"
            className={actionCls}
            title={t('animate.timeline.editFrame')}
            onClick={(e) => { e.stopPropagation(); onEditVersion(frame.versionId, index, frame.track); }}
          >
            <Pencil className="h-2.5 w-2.5" />
          </button>
        )}
        <ReplaceVersionPopover
          projectId={projectId}
          assetId={assetId}
          currentVersionId={frame.versionId}
          onPick={(versionId) => onReplace(index, versionId)}
        >
          <button type="button" className={actionCls} title={t('animate.timeline.replaceFrame')}>
            <ArrowLeftRight className="h-2.5 w-2.5" />
          </button>
        </ReplaceVersionPopover>
        <button
          type="button"
          className={actionCls}
          title={t('animate.timeline.duplicateFrame')}
          onClick={(e) => { e.stopPropagation(); onDuplicate(index); }}
        >
          <Copy className="h-2.5 w-2.5" />
        </button>
      </div>
      {showDuration && (
        <input
          type="number"
          min={20}
          max={10000}
          className="h-5 w-full rounded border bg-background px-1 text-center text-[9px] tabular-nums"
          value={frame.durationMs ?? ''}
          placeholder={String(defaultMs)}
          title={t('animate.timeline.durationMs')}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => {
            const raw = e.target.value.trim();
            onDuration(index, raw === '' ? null : Math.max(20, Math.min(10000, Number(raw) || 20)));
          }}
        />
      )}
    </div>
  );
});
