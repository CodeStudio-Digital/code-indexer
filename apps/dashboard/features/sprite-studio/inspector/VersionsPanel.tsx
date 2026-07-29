/**
 * Inspector card: the active asset's version history. A VIRTUALIZED, bounded
 * scroll list (assets accumulate 100+ versions) with a mini thumbnail per row;
 * the selected-version preview is PINNED below the list as a fixed footer, so it
 * stays visible no matter how far the list is scrolled. Rows select / drag onto
 * the timeline; hover affordances edit-in-place / iterate / curation-delete.
 */
import { useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDay } from '../../../lib/datetime.js';
import { useVirtualizer } from '@tanstack/react-virtual';
import { History } from 'lucide-react';
import { confirm } from '../../../components/ui/prompt-dialog.js';
import { versionFileUrl } from '../api.js';
import type { AssetVersion } from '../types.js';
import { InspectorSection } from './InspectorSection.js';
import { CHECKERBOARD, VersionRow, vLabel } from './VersionRow.js';

const ROW_H = 38;

export function VersionsPanel({
  versions,
  currentVersionId,
  activeVersionId,
  onSelect,
  onDelete,
  onIterate,
  onEditInPlace,
  projectId,
}: {
  versions: AssetVersion[];
  /** The asset's `currentVersionId` — badged in the list. */
  currentVersionId: string | null;
  activeVersionId: string | null;
  onSelect: (versionId: string) => void;
  /** Absent → the delete affordance is hidden (read-only contexts). */
  onDelete?: (versionId: string) => void | Promise<void>;
  /** "Iterate from this version": attach it as a generation reference. */
  onIterate?: (versionId: string, label: string) => void;
  /** Pencil: edit this version IN PLACE (focused session, no new version). */
  onEditInPlace?: (versionId: string) => void;
  /** IDE project id — absent hides thumbnails + the pinned preview pane. */
  projectId?: number;
}) {
  const { t } = useTranslation('spriteStudio');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Newest first (matches the old reversed render order).
  const ordered = useMemo(() => [...versions].reverse(), [versions]);
  const active = activeVersionId != null ? versions.find((v) => v.id === activeVersionId) : undefined;

  const virtualizer = useVirtualizer({
    count: ordered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 8,
  });

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
    <InspectorSection
      id="versions"
      icon={History}
      title={t('inspector.versions')}
      flushBody
      actions={<span className="px-1 text-[10px] tabular-nums text-muted-foreground">{versions.length}</span>}
    >
      {ordered.length === 0 ? (
        <div className="px-2 py-2 text-xs text-muted-foreground">{t('inspector.noVersions')}</div>
      ) : (
        <>
          {/* Only the LIST scrolls — bounded height keeps the preview in view. */}
          <div ref={scrollRef} className="max-h-[240px] overflow-y-auto px-1">
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map((vi) => {
                const v = ordered[vi.index];
                return (
                  <div
                    key={vi.key}
                    className="absolute left-0 w-full py-px"
                    style={{ top: 0, transform: `translateY(${vi.start}px)`, height: vi.size }}
                  >
                    <VersionRow
                      v={v}
                      projectId={projectId}
                      isActive={v.id === activeVersionId}
                      isCurrent={v.id === currentVersionId}
                      onSelect={onSelect}
                      onDelete={onDelete ? (x) => void askDelete(x) : undefined}
                      onIterate={onIterate}
                      onEditInPlace={onEditInPlace}
                    />
                  </div>
                );
              })}
            </div>
          </div>
          {/* Pinned preview footer — fixed below the list, always visible. */}
          {projectId != null && active && (
            <div className="border-t border-border/60 px-2 pt-2">
              <div className="flex h-40 items-center justify-center overflow-hidden rounded border p-1" style={CHECKERBOARD}>
                <img
                  key={`${active.id}:${active.contentHash ?? ''}`}
                  src={versionFileUrl(projectId, active.id, active.contentHash)}
                  alt={t('inspector.versionPreviewAlt', { v: vLabel(active) })}
                  className="h-full w-full object-contain"
                  style={{ imageRendering: 'pixelated' }}
                  draggable={false}
                />
              </div>
              <div className="flex items-center justify-between gap-2 pt-1 text-[10px] text-muted-foreground">
                <span className="min-w-0 truncate font-mono">
                  {`${vLabel(active)} · ${active.width}×${active.height} · ${t(`source.${active.source}`)}`}
                </span>
                <span className="shrink-0">
                  {formatDay(active.createdAt)}
                </span>
              </div>
            </div>
          )}
        </>
      )}
    </InspectorSection>
  );
}
