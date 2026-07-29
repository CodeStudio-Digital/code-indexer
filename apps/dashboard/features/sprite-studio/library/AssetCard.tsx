/**
 * One library thumbnail card. Memoized — hundreds render inside the
 * virtualized grid, so a selection change must not re-render every card.
 * Perf rules for virtual grids: native `title` attribute (NEVER a Radix
 * Tooltip here) and `<img loading="lazy">` over a CSS checkerboard.
 */
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { ImageIcon } from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import type { SpriteAsset } from '../types.js';
import { setAssetDragData } from './asset-drag.js';

/** Transparent-PNG checkerboard, pure CSS (no asset request). */
const CHECKERBOARD: React.CSSProperties = {
  backgroundImage:
    'conic-gradient(rgba(128,128,128,0.18) 0 25%, transparent 0 50%, rgba(128,128,128,0.18) 0 75%, transparent 0)',
  backgroundSize: '16px 16px',
};

const STATUS_CLASS: Record<SpriteAsset['status'], string> = {
  draft: 'bg-muted text-muted-foreground',
  approved: 'bg-emerald-500/15 text-emerald-500',
  archived: 'bg-muted text-muted-foreground/60',
  missing: 'bg-red-500/15 text-red-400',
};

export const AssetCard = memo(function AssetCard({
  asset,
  active,
  onSelect,
  onOpen,
}: {
  asset: SpriteAsset;
  active: boolean;
  onSelect: (id: string) => void;
  /** Double-click — will open the asset in the editor (M3). */
  onOpen?: (id: string) => void;
}) {
  const { t } = useTranslation('spriteStudio');
  return (
    <button
      type="button"
      draggable
      onDragStart={(e) => setAssetDragData(e.dataTransfer, {
        assetId: asset.id, slug: asset.slug, versionId: asset.currentVersionId, thumbUrl: asset.thumbUrl,
      })}
      onClick={() => onSelect(asset.id)}
      onDoubleClick={onOpen ? () => onOpen(asset.id) : undefined}
      title={`${asset.name} · ${asset.width}x${asset.height}`}
      className={cn(
        'flex h-full w-full flex-col overflow-hidden rounded border text-left transition-colors',
        active ? 'border-primary ring-1 ring-primary' : 'border-border hover:border-primary/40',
      )}
    >
      <div className="relative flex h-24 shrink-0 items-center justify-center overflow-hidden" style={CHECKERBOARD}>
        {asset.thumbUrl ? (
          <img
            src={asset.thumbUrl}
            alt={asset.name}
            loading="lazy"
            className="max-h-full max-w-full object-contain"
            style={{ imageRendering: 'pixelated' }}
          />
        ) : (
          <ImageIcon className="h-6 w-6 text-muted-foreground/40" />
        )}
        <span
          className={cn(
            'absolute right-1 top-1 rounded px-1 py-px text-[9px] font-medium leading-tight',
            STATUS_CLASS[asset.status],
          )}
        >
          {t(`status.${asset.status}`)}
        </span>
      </div>
      <div className="min-w-0 border-t px-1.5 py-1">
        <div className="truncate text-[11px] font-medium leading-tight">{asset.name}</div>
        <div className="truncate text-[10px] text-muted-foreground">
          {t(`category.${asset.category}`)}
          {' · '}
          {`${asset.width}x${asset.height}`}
        </div>
      </div>
    </button>
  );
});
