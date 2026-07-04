/**
 * Generic version-picker popover: lists the asset's version history (fetched
 * lazily on open via the existing listVersions) as a thumb grid; picking one
 * calls onPick with the version id. Consumed by ReplaceVersionPopover (frame
 * "Substituir"), the timeline's append-frame "+" zone and the generation
 * AnchorPicker — one grid, three verbs. Versions are immutable, so pickers
 * never touch files; every consumer does pure pointer surgery.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover.js';
import { listVersions, versionThumbUrl } from '../api.js';
import type { AssetVersion } from '../types.js';

export function VersionPickerPopover({
  projectId, assetId, currentVersionId, title, onPick, clearLabel, onClear, children,
}: {
  projectId: number;
  assetId: number;
  /** Highlighted entry (what the consumer points at today); null = none. */
  currentVersionId: number | null;
  /** Popover heading — already translated by the consumer. */
  title: string;
  onPick: (versionId: number) => void;
  /** Optional footer action (e.g. anchor picker's "use current version"). */
  clearLabel?: string;
  onClear?: () => void;
  /** Trigger element. */
  children: React.ReactNode;
}) {
  const { t } = useTranslation('spriteStudio');
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<AssetVersion[] | null>(null);

  // Fetch on open; refetch each time so freshly aligned/edited versions show.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setVersions(null);
    void listVersions(projectId, assetId)
      .then((list) => alive && setVersions([...list].sort((a, b) => b.version - a.version)))
      .catch(() => alive && setVersions([]));
    return () => { alive = false; };
  }, [open, projectId, assetId]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-56 p-2" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {title}
        </div>
        {versions == null ? (
          <div className="flex items-center justify-center gap-1 py-3 text-[10px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> {t('animate.timeline.replaceLoading')}
          </div>
        ) : versions.length === 0 ? (
          <div className="py-2 text-[10px] text-muted-foreground">{t('animate.timeline.replaceEmpty')}</div>
        ) : (
          <div className="grid max-h-48 grid-cols-4 gap-1 overflow-y-auto">
            {versions.map((v) => (
              <button
                key={v.id}
                type="button"
                className={`relative aspect-square overflow-hidden rounded border bg-muted/40 hover:border-primary ${
                  v.id === currentVersionId ? 'border-primary ring-1 ring-primary/50' : 'border-border'
                }`}
                title={t('animate.timeline.versionAlt', { v: v.version })}
                onClick={() => { onPick(v.id); setOpen(false); }}
              >
                <img
                  src={versionThumbUrl(projectId, v.id, 64)}
                  alt={t('animate.timeline.versionAlt', { v: v.version })}
                  loading="lazy"
                  className="h-full w-full object-contain"
                  style={{ imageRendering: 'pixelated' }}
                  draggable={false}
                />
                <span className="absolute bottom-0 right-0 rounded-tl bg-background/80 px-0.5 text-[8px] tabular-nums">
                  {`v${v.version}`}
                </span>
              </button>
            ))}
          </div>
        )}
        {clearLabel && onClear && (
          <button
            type="button"
            className="mt-1.5 w-full rounded border px-1.5 py-1 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => { onClear(); setOpen(false); }}
          >
            {clearLabel}
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}
