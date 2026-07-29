/**
 * One version tile in the Frames browser: a pixel-perfect thumbnail, its
 * version badge, a selection checkbox (in select mode), an "em uso" dot when
 * the version is on the current timeline, and it is a drag source onto the
 * timeline (reuses version-drag.ts). Subscribes to the session store directly
 * for its selected/selectMode/in-use flags (cheap zustand selectors).
 */
import { Check } from 'lucide-react';
import { cn } from '../../../../lib/utils.js';
import { versionThumbUrl } from '../../api.js';
import type { AssetVersion } from '../../types.js';
import { setVersionDragData } from '../../version-drag.js';
import { useAnimateSession } from '../animate-session-store.js';

const vLabel = (v: AssetVersion): string => `v${String(v.version).padStart(3, '0')}`;

export function VersionMiniThumb({
  projectId,
  version,
  isCurrent,
  onClick,
}: {
  projectId: number;
  version: AssetVersion;
  isCurrent: boolean;
  onClick: (id: string, e: React.MouseEvent) => void;
}) {
  const selected = useAnimateSession((s) => s.selected.has(version.id));
  const selectMode = useAnimateSession((s) => s.selectMode);
  const inUse = useAnimateSession((s) => s.frameVersionIds.includes(version.id));

  return (
    <button
      type="button"
      draggable
      onDragStart={(e) => setVersionDragData(e.dataTransfer, {
        versionId: version.id, assetId: version.assetId, version: version.version, label: vLabel(version),
      })}
      onClick={(e) => onClick(version.id, e)}
      title={`${vLabel(version)} · ${version.width}×${version.height}`}
      className={cn(
        'group relative flex aspect-square w-full cursor-grab items-center justify-center overflow-hidden rounded border bg-muted/30 active:cursor-grabbing',
        selected ? 'border-primary ring-1 ring-primary' : 'border-border hover:border-primary/50',
      )}
    >
      <img
        src={versionThumbUrl(projectId, version.id, 96, version.contentHash)}
        alt={vLabel(version)}
        className="h-full w-full object-contain"
        style={{ imageRendering: 'pixelated' }}
        draggable={false}
      />
      <span className="pointer-events-none absolute bottom-0 left-0 rounded-tr bg-background/80 px-1 text-[8px] font-mono leading-tight text-muted-foreground">
        {version.version}
      </span>
      {inUse && (
        <span className="pointer-events-none absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-emerald-400" />
      )}
      {(selectMode || selected) && (
        <span
          className={cn(
            'pointer-events-none absolute left-0.5 top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-sm border',
            selected ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/50 bg-background/70',
          )}
        >
          {selected && <Check className="h-2.5 w-2.5" />}
        </span>
      )}
      {isCurrent && (
        <span className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-primary" />
      )}
    </button>
  );
}
