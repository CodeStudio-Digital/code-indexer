/**
 * RIGHT-rail inspector for animate mode — same collapsible-section shell as the
 * editor inspector. Three sections:
 *   • Frame — the timeline-selected frame (preview + Edit / Re-roll).
 *   • Camadas — the timeline's TRACKS, separated (name · frame count · eye),
 *     click a row to make it the active track. This is how multi-track is
 *     surfaced here (the inspector used to be track-unaware).
 *   • Lote — the loaded animation's generation batch (sibling versions) with
 *     the ✂ RE-SLICE (which now lives here, next to Edit/Re-roll, and targets
 *     the LOADED animation — not a stray "last generation").
 * The selected frame, the tracks and the loaded-animation context are published
 * by AnimatePanel into the session store (the panels live in separate rails).
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dices, Eye, EyeOff, Film, Grid3x3, Layers, Pencil, Scissors } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { cn } from '../../../lib/utils.js';
import { versionFileUrl } from '../api.js';
import type { AssetVersion } from '../types.js';
import { InspectorSection } from '../inspector/InspectorSection.js';
import { useAnimateSession } from './animate-session-store.js';
import type { GenerationGroup } from './api-anim-bulk.js';
import { FrameRerollPopover } from './FrameRerollPopover.js';
import { gridFor } from './version-groups.js';
import { VersionMiniGrid } from './frames/VersionMiniGrid.js';
import { SelectionActionBar } from './frames/SelectionActionBar.js';
import { ResliceSheetDialog } from './frames/ResliceSheetDialog.js';
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
  versionById: Map<string, AssetVersion>;
  generations: GenerationGroup[];
  refresh: () => void;
  onEditVersion: (versionId: string, frameIndex: number, track: number) => void;
  onSelectVersion: (versionId: string) => void;
}) {
  const { t } = useTranslation('spriteStudio');
  const selId = useAnimateSession((s) => s.selectedFrameVersionId);
  const tracks = useAnimateSession((s) => s.inspectorTracks);
  const activeTrack = useAnimateSession((s) => s.activeTrack);
  const selectedFrameIndex = useAnimateSession((s) => s.selectedFrameIndex);
  const animContext = useAnimateSession((s) => s.animContext);
  const onActivateTrack = useAnimateSession((s) => s.onActivateTrack);
  const onToggleTrackVisible = useAnimateSession((s) => s.onToggleTrackVisible);
  const { busy, deleteVersions, addToTimeline } = useSelectionActions(projectId, refresh);
  const sel = selId != null ? versionById.get(selId) ?? null : null;
  const [resliceTarget, setResliceTarget] = useState<{
    assetId: string;
    jobId: string;
    defaultGrid: { cols: number; rows: number };
  } | null>(null);

  // The batch: prefer the LOADED animation's generation (so the ✂ re-slices what
  // is on the timeline), else the selected frame's own batch.
  const loadedGroup = useMemo(
    () => (animContext?.jobId != null ? generations.find((g) => g.jobId === animContext.jobId) ?? null : null),
    [animContext?.jobId, generations],
  );
  const selGroup = useMemo(
    () => (selId != null ? generations.find((x) => x.versionIds.includes(selId)) ?? null : null),
    [selId, generations],
  );
  const batchGroup = loadedGroup ?? selGroup;
  const batch = useMemo(() => {
    if (!batchGroup) return sel ? [sel] : [];
    return batchGroup.versionIds.map((id) => versionById.get(id)).filter((v): v is AssetVersion => v != null);
  }, [batchGroup, versionById, sel]);
  const orderedIds = useMemo(() => batch.map((v) => v.id), [batch]);
  const resliceAssetId = animContext?.assetId ?? sel?.assetId ?? batch[0]?.assetId ?? null;
  const canReslice = batchGroup?.hasSheet === true && batchGroup.jobId != null && resliceAssetId != null;
  const openReslice = () => {
    if (!canReslice || !batchGroup || batchGroup.jobId == null || resliceAssetId == null) return;
    setResliceTarget({
      assetId: resliceAssetId,
      jobId: batchGroup.jobId,
      defaultGrid: batchGroup.animationId != null
        ? { cols: Math.max(1, batchGroup.frameCount), rows: 1 }
        : gridFor(batchGroup.frameCount),
    });
  };

  const onThumbClick = (id: string, e: React.MouseEvent) => {
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
      <div className="min-h-0 flex-1 overflow-y-auto">
        <InspectorSection id="animFrame" icon={Film} title={t('animate.inspector.frameTitle')} bodyClassName="space-y-1.5">
          {!sel ? (
            <div className="py-2 text-center text-[11px] text-muted-foreground">{t('animate.inspector.noFrame')}</div>
          ) : (
            <>
              <div className="flex h-40 items-center justify-center overflow-hidden rounded border p-1" style={CHECKERBOARD}>
                <img
                  key={`${sel.id}:${sel.contentHash ?? ''}`}
                  src={versionFileUrl(projectId, sel.id, sel.contentHash)}
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
                <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs" title={t('animate.timeline.editFrame')}
                  onClick={() => onEditVersion(sel.id, selectedFrameIndex ?? 0, activeTrack)}>
                  <Pencil className="h-3 w-3" /> {t('frames.edit')}
                </Button>
                <FrameRerollPopover projectId={projectId} assetId={sel.assetId} versionId={sel.id} prompt={sel.prompt} refresh={refresh}>
                  <Button size="sm" variant="outline" className="h-6 gap-1 px-1.5 text-[10px]">
                    <Dices className="h-3 w-3" /> {t('animate.reroll')}
                  </Button>
                </FrameRerollPopover>
              </div>
            </>
          )}
        </InspectorSection>

        {tracks.length > 0 && (
          <InspectorSection
            id="animTracks" icon={Layers} title={t('animate.inspector.tracksTitle')}
            bodyClassName="space-y-px"
            actions={<span className="px-1 text-[10px] tabular-nums text-muted-foreground">{tracks.length}</span>}
          >
            {tracks.map((tr) => (
              <div
                key={tr.id}
                className={cn(
                  'flex items-center gap-1.5 rounded px-1.5 py-1 text-[11px]',
                  tr.id === activeTrack ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
                  !tr.visible && 'opacity-50',
                )}
              >
                <button
                  type="button" onClick={() => onToggleTrackVisible?.(tr.id, !tr.visible)}
                  title={tr.visible ? t('layers.hide') : t('layers.show')}
                  aria-label={tr.visible ? t('layers.hide') : t('layers.show')}
                  className="flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
                >
                  {tr.visible ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                </button>
                <button
                  type="button" onClick={() => onActivateTrack?.(tr.id)}
                  title={t('animate.inspector.activateTrack')}
                  className="min-w-0 flex-1 truncate text-left"
                >
                  {tr.name}
                </button>
                <span className="shrink-0 text-[10px] tabular-nums opacity-70">{t('animate.inspector.trackCount', { n: tr.count })}</span>
              </div>
            ))}
          </InspectorSection>
        )}

        {batch.length > 0 && (
          <InspectorSection
            id="animBatch" icon={Grid3x3} title={t('frames.thisBatch')} flushBody
            actions={canReslice && (
              <button
                type="button" onClick={openReslice}
                aria-label={t('frames.reslice')} title={t('frames.reslice')}
                className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-primary/15 hover:text-primary"
              >
                <Scissors className="h-3 w-3" />
              </button>
            )}
          >
            <VersionMiniGrid
              projectId={projectId}
              versions={batch}
              cols={4}
              currentVersionId={null}
              onThumbClick={onThumbClick}
            />
          </InspectorSection>
        )}
      </div>
      <SelectionActionBar onAddToTimeline={() => addToTimeline(orderedIds)} onDelete={() => void deleteVersions([...useAnimateSession.getState().selected])} busy={busy} />
      {resliceTarget && (
        <ResliceSheetDialog
          open
          onOpenChange={(v) => { if (!v) setResliceTarget(null); }}
          projectId={projectId}
          assetId={resliceTarget.assetId}
          jobId={resliceTarget.jobId}
          defaultGrid={resliceTarget.defaultGrid}
          refresh={refresh}
        />
      )}
    </div>
  );
}
