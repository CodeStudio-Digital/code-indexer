/**
 * Inspector card: the active asset's version history. Clicking a row selects
 * it as the active version; the trash affordance (hover) curation-deletes a
 * version after confirmation — repo file + manifest entry + mirror row go
 * together on the backend. When a projectId is provided, the selected version
 * also renders a Unity-style checkerboard preview below the list.
 */
import { useTranslation } from 'react-i18next';
import { History, Trash2, Wand2 } from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import { confirm } from '../../../components/ui/prompt-dialog.js';
import { versionFileUrl } from '../api.js';
import type { AssetVersion } from '../types.js';
import { setVersionDragData } from '../version-drag.js';

/** Pure-CSS transparent checkerboard (same trick as VariantCard). */
const CHECKERBOARD: React.CSSProperties = {
  backgroundImage:
    'conic-gradient(rgba(128,128,128,0.18) 0 25%, transparent 0 50%, rgba(128,128,128,0.18) 0 75%, transparent 0)',
  backgroundSize: '16px 16px',
};

const vLabel = (v: AssetVersion): string => `v${String(v.version).padStart(3, '0')}`;

export function VersionsPanel({
  versions,
  currentVersionId,
  activeVersionId,
  onSelect,
  onDelete,
  onIterate,
  projectId,
}: {
  versions: AssetVersion[];
  /** The asset's `currentVersionId` — badged in the list. */
  currentVersionId: number | null;
  activeVersionId: number | null;
  onSelect: (versionId: number) => void;
  /** Absent → the delete affordance is hidden (read-only contexts). */
  onDelete?: (versionId: number) => void | Promise<void>;
  /** "Iterate from this version": attach it as a generation reference. */
  onIterate?: (versionId: number, label: string) => void;
  /** IDE project id — absent hides the selected-version preview pane. */
  projectId?: number;
}) {
  const { t } = useTranslation('spriteStudio');
  const active = activeVersionId != null ? versions.find((v) => v.id === activeVersionId) : undefined;

  const askDelete = async (v: AssetVersion) => {
    const ok = await confirm({
      title: t('inspector.deleteVersionTitle'),
      description: t('inspector.deleteVersionBody', { v: vLabel(v) }),
      confirmLabel: t('inspector.deleteConfirm'),
      tone: 'destructive',
    });
    if (ok) await onDelete?.(v.id);
  };

  return (
    <div className="space-y-1 rounded border p-2">
      <div className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        <History className="h-3 w-3" /> {t('inspector.versions')}
      </div>
      {versions.length === 0 ? (
        <div className="py-2 text-xs text-muted-foreground">{t('inspector.noVersions')}</div>
      ) : (
        <div className="space-y-px">
          {[...versions].reverse().map((v) => (
            <div
              key={v.id}
              // Rows drag onto the animation timeline (replace a frame / append).
              draggable
              onDragStart={(e) => setVersionDragData(e.dataTransfer, {
                versionId: v.id, assetId: v.assetId, version: v.version, label: vLabel(v),
              })}
              title={t('inspector.dragVersionHint')}
              className={cn(
                'group flex w-full cursor-grab items-center gap-2 rounded px-1.5 py-1 text-left text-[11px] transition-colors active:cursor-grabbing',
                v.id === activeVersionId
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <button type="button" onClick={() => onSelect(v.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                <span className="font-mono font-medium">{vLabel(v)}</span>
                <span className="min-w-0 flex-1 truncate">
                  {t(`source.${v.source}`)}
                  {' · '}
                  {`${v.width}x${v.height}`}
                </span>
                {v.id === currentVersionId && (
                  <span className="rounded bg-primary/15 px-1 py-px text-[9px] font-medium text-primary">
                    {t('inspector.currentBadge')}
                  </span>
                )}
                <span className="shrink-0 text-[10px] opacity-70">
                  {v.createdAt ? new Date(v.createdAt).toLocaleDateString() : ''}
                </span>
              </button>
              {onIterate && (
                <button
                  type="button"
                  onClick={() => onIterate(v.id, vLabel(v))}
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
                  onClick={() => void askDelete(v)}
                  title={t('inspector.deleteVersion')}
                  aria-label={t('inspector.deleteVersion')}
                  className="shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-red-500/15 hover:text-red-400 group-hover:opacity-100"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {projectId != null && active && (
        <div className="space-y-1 pt-1">
          <div
            className="flex h-40 items-center justify-center overflow-hidden rounded border p-1"
            style={CHECKERBOARD}
          >
            <img
              key={active.id}
              src={versionFileUrl(projectId, active.id)}
              alt={t('inspector.versionPreviewAlt', { v: vLabel(active) })}
              className="h-full w-full object-contain"
              style={{ imageRendering: 'pixelated' }}
              draggable={false}
            />
          </div>
          <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
            <span className="min-w-0 truncate font-mono">
              {`${vLabel(active)} · ${active.width}×${active.height} · ${t(`source.${active.source}`)}`}
            </span>
            <span className="shrink-0">
              {active.createdAt ? new Date(active.createdAt).toLocaleDateString() : ''}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
