/**
 * ProjectImagesPanel — the left rail "files" tab: browse the IDE project's
 * folders and preview the images inside (png/jpg/jpeg/gif/webp), one
 * directory level at a time via the sprite-studio project-files routes.
 *
 * Perf rules follow library/AssetCard: memoized grid cells, native `title`
 * attribute (never a Radix tooltip in a grid) and `<img loading="lazy">`
 * over a pure-CSS checkerboard. Drag-to-reference-slots lands in a later
 * wave — the footer hint says so; no drag wiring here yet.
 */
import { memo, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, CornerLeftUp, Folder, Home, Loader2, MousePointer2 } from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import {
  listProjectImages, projectImageUrl,
  type ProjectImageEntry, type ProjectImagesListing,
} from './api-files.js';

/** Transparent-image checkerboard, pure CSS (no asset request). */
const CHECKERBOARD: React.CSSProperties = {
  backgroundImage:
    'conic-gradient(rgba(128,128,128,0.18) 0 25%, transparent 0 50%, rgba(128,128,128,0.18) 0 75%, transparent 0)',
  backgroundSize: '16px 16px',
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const ImageCell = memo(function ImageCell({
  projectId, image,
}: {
  projectId: number;
  image: ProjectImageEntry;
}) {
  return (
    <div
      className="flex flex-col overflow-hidden rounded border border-border"
      title={`${image.rel} · ${formatSize(image.size)}`}
    >
      <div className="flex h-16 items-center justify-center overflow-hidden" style={CHECKERBOARD}>
        <img
          src={projectImageUrl(projectId, image.rel)}
          alt={image.name}
          loading="lazy"
          className="max-h-full max-w-full object-contain"
        />
      </div>
      <div className="truncate border-t px-1 py-0.5 text-[10px] leading-tight">{image.name}</div>
    </div>
  );
});

export function ProjectImagesPanel({ projectId }: { projectId: number }) {
  const { t } = useTranslation('spriteStudio');
  const [dir, setDir] = useState('');
  const [listing, setListing] = useState<ProjectImagesListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Switching projects resets navigation to the new project's root.
  useEffect(() => { setDir(''); }, [projectId]);

  useEffect(() => {
    let stale = false;
    setLoading(true);
    setError(null);
    listProjectImages(projectId, dir)
      .then((l) => { if (!stale) setListing(l); })
      .catch((e: unknown) => {
        if (!stale) { setListing(null); setError(e instanceof Error ? e.message : String(e)); }
      })
      .finally(() => { if (!stale) setLoading(false); });
    return () => { stale = true; };
  }, [projectId, dir]);

  const enter = useCallback((name: string) => setDir((d) => (d ? `${d}/${name}` : name)), []);
  const segments = dir ? dir.split('/') : [];
  const isEmpty = !loading && !error && listing != null
    && listing.dirs.length === 0 && listing.images.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center gap-0.5 border-b px-2 py-1 text-[11px]">
        <button
          type="button"
          title={t('panels.root')}
          aria-label={t('panels.root')}
          onClick={() => setDir('')}
          className={cn('rounded p-0.5 hover:bg-muted', dir === '' ? 'text-foreground' : 'text-muted-foreground')}
        >
          <Home className="h-3 w-3" />
        </button>
        {segments.map((seg, i) => (
          <span key={segments.slice(0, i + 1).join('/')} className="flex min-w-0 items-center gap-0.5">
            <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/50" />
            <button
              type="button"
              title={seg}
              onClick={() => setDir(segments.slice(0, i + 1).join('/'))}
              className={cn(
                'max-w-[120px] truncate rounded px-0.5 hover:bg-muted',
                i === segments.length - 1 ? 'text-foreground' : 'text-muted-foreground',
              )}
            >
              {seg}
            </button>
          </span>
        ))}
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {loading ? (
          <div className="flex items-center justify-center p-4 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : error ? (
          <div className="rounded border border-red-500/40 bg-red-500/10 p-2 text-[11px] text-red-400">
            <div className="font-medium">{t('panels.loadFailed')}</div>
            <div className="truncate opacity-80">{error}</div>
          </div>
        ) : (
          <>
            {(dir !== '' || (listing?.dirs.length ?? 0) > 0) && (
              <div className="space-y-px">
                {dir !== '' && (
                  <FolderRow
                    icon={CornerLeftUp}
                    label={t('panels.up')}
                    muted
                    onClick={() => setDir(segments.slice(0, -1).join('/'))}
                  />
                )}
                {listing?.dirs.map((name) => (
                  <FolderRow key={name} icon={Folder} label={name} onClick={() => enter(name)} />
                ))}
              </div>
            )}
            {(listing?.images.length ?? 0) > 0 && (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-1.5">
                {listing?.images.map((img) => (
                  <ImageCell key={img.rel} projectId={projectId} image={img} />
                ))}
              </div>
            )}
            {isEmpty && (
              <div className="p-3 text-center text-[11px] text-muted-foreground">{t('panels.empty')}</div>
            )}
          </>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5 border-t px-2 py-1 text-[10px] text-muted-foreground">
        <MousePointer2 className="h-3 w-3 shrink-0" />
        <span className="truncate" title={t('panels.dragSoon')}>{t('panels.dragSoon')}</span>
      </div>
    </div>
  );
}

function FolderRow({
  icon, label, onClick, muted,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  muted?: boolean;
}) {
  const Icon = icon;
  return (
    <button
      type="button"
      title={label}
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] transition-colors hover:bg-muted',
        muted ? 'text-muted-foreground' : 'text-foreground',
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}
