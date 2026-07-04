/**
 * RIGHT-rail inspector for animate mode: the timeline-selected frame (large
 * checkerboard preview + provenance + Edit / Re-roll) and a "deste lote"
 * mini-grid of the sibling versions from the same generation batch, sharing the
 * unified selection store + the bulk action bar. The selected frame + its index
 * are published by AnimatePanel into the session store.
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Dices, Pencil } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { versionFileUrl } from '../api.js';
import type { AssetVersion } from '../types.js';
import { useAnimateSession } from './animate-session-store.js';
import type { GenerationGroup } from './api-anim-bulk.js';
import { FrameRerollPopover } from './FrameRerollPopover.js';
import { VersionMiniGrid } from './frames/VersionMiniGrid.js';
import { SelectionActionBar } from './frames/SelectionActionBar.js';
import { useSelectionActions } from './frames/useSelectionActions.js';

const CHECKERBOARD: React.CSSProperties = {
  backgroundImage:
    'conic-gradient(rgba(128,128,128,0.18) 0 25%, transparent 0 50%, rgba(128,128,128,0.18) 0 75%, transparent 0)',
  backgroundSize: '16px 16px',
};
const vLabel = (v: AssetVersion): string => `v${String(v.version).padStart(3, '0')}`;

export function FrameInspector({
  projectId,
  versionById,
  generations,
  refresh,
  onEditVersion,
  onSelectVersion,
}: {
  projectId: number;
  versionById: Map<number, AssetVersion>;
  generations: GenerationGroup[];
  refresh: () => void;
  onEditVersion: (versionId: number) => void;
  onSelectVersion: (versionId: number) => void;
}) {
  const { t } = useTranslation('spriteStudio');
  const selId = useAnimateSession((s) => s.selectedFrameVersionId);
  const { busy, deleteVersions, addToTimeline } = useSelectionActions(projectId, refresh);
  const sel = selId != null ? versionById.get(selId) ?? null : null;

  // The batch (generation group) the selected frame belongs to.
  const batch = useMemo(() => {
    if (selId == null) return [] as AssetVersion[];
    const g = generations.find((x) => x.versionIds.includes(selId));
    if (!g) return sel ? [sel] : [];
    return g.versionIds.map((id) => versionById.get(id)).filter((v): v is AssetVersion => v != null);
  }, [selId, generations, versionById, sel]);
  const orderedIds = useMemo(() => batch.map((v) => v.id), [batch]);

  const onThumbClick = (id: number, e: React.MouseEvent) => {
    const s = useAnimateSession.getState();
    if (s.selectMode || e.shiftKey || e.metaKey || e.ctrlKey) {
      if (e.shiftKey) s.selectRange(id, orderedIds);
      else s.toggleOne(id);
    } else {
      onSelectVersion(id);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {!sel ? (
          <div className="rounded border p-3 text-center text-[11px] text-muted-foreground">
            {t('animate.inspector.noFrame')}
          </div>
        ) : (
          <div className="space-y-1 rounded border p-2">
            <div className="flex h-40 items-center justify-center overflow-hidden rounded border p-1" style={CHECKERBOARD}>
              <img
                key={sel.id}
                src={versionFileUrl(projectId, sel.id)}
                alt={vLabel(sel)}
                className="h-full w-full object-contain"
                style={{ imageRendering: 'pixelated' }}
                draggable={false}
              />
            </div>
            <div className="truncate font-mono text-[10px] text-muted-foreground">
              {`${vLabel(sel)} · ${sel.width}×${sel.height} · ${t(`source.${sel.source}`)}`}
              {sel.jobId != null ? ` · job#${sel.jobId}` : ''}
            </div>
            <div className="flex items-center gap-1">
              <Button size="sm" variant="outline" className="h-6 gap-1 px-1.5 text-[10px]" title={t('animate.timeline.editFrame')} onClick={() => onEditVersion(sel.id)}>
                <Pencil className="h-3 w-3" /> {t('frames.edit')}
              </Button>
              <FrameRerollPopover projectId={projectId} assetId={sel.assetId} versionId={sel.id} prompt={sel.prompt} refresh={refresh}>
                <Button size="sm" variant="outline" className="h-6 gap-1 px-1.5 text-[10px]">
                  <Dices className="h-3 w-3" /> {t('animate.reroll')}
                </Button>
              </FrameRerollPopover>
            </div>
          </div>
        )}

        {batch.length > 0 && (
          <div className="rounded border">
            <div className="border-b px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {t('frames.thisBatch')}
            </div>
            <VersionMiniGrid
              projectId={projectId}
              versions={batch}
              cols={4}
              currentVersionId={null}
              onThumbClick={onThumbClick}
            />
          </div>
        )}
      </div>
      <SelectionActionBar onAddToTimeline={() => addToTimeline(orderedIds)} onDelete={() => void deleteVersions([...useAnimateSession.getState().selected])} busy={busy} />
    </div>
  );
}
