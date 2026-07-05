/**
 * One row of the inspector Versions list: a mini checkerboard thumbnail + the
 * version label / provenance, with hover affordances (edit-in-place, iterate,
 * delete) and drag-to-timeline. Memoized so the virtualized list stays cheap.
 */
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil, Trash2, Wand2 } from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import { versionThumbUrl } from '../api.js';
import type { AssetVersion } from '../types.js';
import { setVersionDragData } from '../version-drag.js';

/** Pure-CSS transparent checkerboard (shared with the preview pane). */
export const CHECKERBOARD: React.CSSProperties = {
  backgroundImage:
    'conic-gradient(rgba(128,128,128,0.18) 0 25%, transparent 0 50%, rgba(128,128,128,0.18) 0 75%, transparent 0)',
  backgroundSize: '12px 12px',
};

export const vLabel = (v: AssetVersion): string => `v${String(v.version).padStart(3, '0')}`;

export const VersionRow = memo(function VersionRow({
  v,
  projectId,
  isActive,
  isCurrent,
  onSelect,
  onDelete,
  onIterate,
  onEditInPlace,
}: {
  v: AssetVersion;
  projectId?: number;
  isActive: boolean;
  isCurrent: boolean;
  onSelect: (versionId: number) => void;
  onDelete?: (v: AssetVersion) => void;
  onIterate?: (versionId: number, label: string) => void;
  onEditInPlace?: (versionId: number) => void;
}) {
  const { t } = useTranslation('spriteStudio');
  const label = vLabel(v);
  return (
    <div
      draggable
      onDragStart={(e) => setVersionDragData(e.dataTransfer, {
        versionId: v.id, assetId: v.assetId, version: v.version, label,
      })}
      title={t('inspector.dragVersionHint')}
      className={cn(
        'group flex h-full cursor-grab items-center gap-1.5 rounded px-1.5 text-left text-[11px] transition-colors active:cursor-grabbing',
        isActive ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      <div className="h-7 w-7 shrink-0 overflow-hidden rounded border border-border/60" style={CHECKERBOARD}>
        {projectId != null && (
          <img
            src={versionThumbUrl(projectId, v.id, 64, v.contentHash)}
            alt={label}
            className="h-full w-full object-contain"
            style={{ imageRendering: 'pixelated' }}
            draggable={false}
            loading="lazy"
          />
        )}
      </div>
      <button type="button" onClick={() => onSelect(v.id)} className="flex min-w-0 flex-1 flex-col text-left">
        <span className="flex items-center gap-1">
          <span className="font-mono font-medium">{label}</span>
          {isCurrent && (
            <span className="rounded bg-primary/15 px-1 py-px text-[9px] font-medium text-primary">
              {t('inspector.currentBadge')}
            </span>
          )}
        </span>
        <span className="min-w-0 truncate text-[10px] opacity-70">
          {t(`source.${v.source}`)}{' · '}{`${v.width}×${v.height}`}
        </span>
      </button>
      {onEditInPlace && (
        <button
          type="button"
          onClick={() => onEditInPlace(v.id)}
          title={t('inspector.editInPlace')}
          aria-label={t('inspector.editInPlace')}
          className="shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-primary/15 hover:text-primary group-hover:opacity-100"
        >
          <Pencil className="h-3 w-3" />
        </button>
      )}
      {onIterate && (
        <button
          type="button"
          onClick={() => onIterate(v.id, label)}
          title={t('inspector.iterateVersion')}
          aria-label={t('inspector.iterateVersion')}
          className="shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-primary/15 hover:text-primary group-hover:opacity-100"
        >
          <Wand2 className="h-3 w-3" />
        </button>
      )}
      {onDelete && (
        <button
          type="button"
          onClick={() => onDelete(v)}
          title={t('inspector.deleteVersion')}
          aria-label={t('inspector.deleteVersion')}
          className="shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-red-500/15 hover:text-red-400 group-hover:opacity-100"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      )}
    </div>
  );
});
