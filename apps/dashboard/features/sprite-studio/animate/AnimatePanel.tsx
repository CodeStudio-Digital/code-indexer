/**
 * AnimatePanel — the multi-track animation surface: header (select/create),
 * frame-pack generate bar, composited PreviewCanvas and the layered
 * TimelineStrip. Export name + props are the CONTRACT CenterSurface mounts
 * against. The heavy lifting lives in hooks: useFrameDraft (flat draft +
 * per-track debounced PATCH), useTimelineOps (column/cell ops + bridge),
 * useAnimGeneration (generate → adopt, base track), useTimelineShortcuts.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '../../../components/ui/prompt-dialog.js';
import { useSpriteJobs } from '../jobs/useSpriteJobs.js';
import type { AssetVersion, SpriteAsset, StudioSettings } from '../types.js';
import * as anim from './api-anim.js';
import { AnimHeader } from './AnimHeader.js';
import { GenerateBar } from './GenerateBar.js';
import { PreviewCanvas } from './PreviewCanvas.js';
import { TimelineStrip } from './TimelineStrip.js';
import type { GenerationGroup } from './api-anim-bulk.js';
import { useAnimateSession, type AnimContext } from './animate-session-store.js';
import { buildTimelineModel } from './timeline-model.js';
import { useAnimGeneration } from './useAnimGeneration.js';
import { useFrameDraft } from './useFrameDraft.js';
import { useTimelineOps } from './useTimelineOps.js';
import { useTimelineShortcuts } from './useTimelineShortcuts.js';

export function AnimatePanel({
  projectId,
  asset,
  // Style is applied server-side (project style contract) — prop kept for the
  // CenterSurface mount contract.
  settings: _settings,
  versionById,
  generations,
  refreshVersions,
  onSaved,
  onEditVersion,
  onExportAnimation,
}: {
  projectId: number;
  asset: SpriteAsset;
  settings: StudioSettings | null;
  /** Shared version lookup (lifted useAssetVersions) — provenance titles. */
  versionById: Map<number, AssetVersion>;
  /** Generation batches — resolves whether the last gen kept its sheet. */
  generations: GenerationGroup[];
  /** Re-pull the shared version list after adopt/align create new rows. */
  refreshVersions: () => void;
  onSaved: (assetId: number, versionId: number) => void;
  /** Open a frame's version in the editor (wired by CenterSurface/StudioView). */
  onEditVersion?: (versionId: number, frameIndex: number, track: number) => void;
  onExportAnimation?: () => void;
}) {
  const { t } = useTranslation('spriteStudio');
  const { jobs } = useSpriteJobs(projectId);

  const [animations, setAnimations] = useState<anim.SpriteAnimation[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [frameCount, setFrameCount] = useState(4);
  const [anchorId, setAnchorId] = useState<number | null>(null);
  const [activeTrack, setActiveTrack] = useState(0);
  const [aligning, setAligning] = useState(false);
  const [repositioning, setRepositioning] = useState(false);
  const [direction, setDirection] = useState('');
  const [error, setError] = useState<string | null>(null);
  const selectedIdRef = useRef<number | null>(null);
  const assetIdRef = useRef(asset.id);

  const current = animations.find((a) => a.id === selectedId) ?? null;
  const lastGenGroup = current?.lastGenJobId != null
    ? generations.find((g) => g.jobId === current.lastGenJobId) ?? null
    : null;

  const applyServer = useCallback((updated: anim.SpriteAnimation) => {
    setAnimations((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
  }, []);

  const {
    frames, frameIdx, setFrameIdx, applyFlat, resetForAnimation, flushPendingSave,
    canUndo, canRedo, undo, redo,
  } =
    useFrameDraft(current, applyServer, setError);
  const tracks = useMemo(
    () => current?.tracks ?? [{ id: 0, name: 'Base', visible: true }],
    [current?.tracks],
  );
  const model = useMemo(
    () => buildTimelineModel(frames, tracks, current?.fps ?? 8),
    [frames, tracks, current?.fps],
  );
  const ops = useTimelineOps({
    model, frames, activeTrack, frameIdx, setFrameIdx, applyFlat, hasAnimation: current != null,
  });
  const { generate, running, adopting, failed, genState } = useAnimGeneration({
    current, assetId: asset.id, jobs, direction, anchorId, frameCount,
    applyServer, onSaved, refreshVersions, onError: setError,
  });
  useTimelineShortcuts(ops, frameIdx, model.gridLen, setFrameIdx, current != null);

  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);
  useEffect(() => { assetIdRef.current = asset.id; }, [asset.id]);

  // Load animations per asset; keep the selection when possible.
  useEffect(() => {
    let alive = true;
    setError(null);
    void anim.listAnimations(projectId, asset.id)
      .then((list) => {
        if (!alive) return;
        setAnimations(list);
        setSelectedId((prev) => (list.some((a) => a.id === prev) ? prev : list[0]?.id ?? null));
      })
      .catch((e) => alive && setError((e as Error).message));
    return () => { alive = false; };
  }, [projectId, asset.id]);

  // Reset the draft + hydrate anchor/frameCount/track on animation switch only
  // (locally-picked values must survive PATCH echoes from timeline edits).
  useEffect(() => { resetForAnimation(current?.frames ?? []); setActiveTrack(0); }, [selectedId, current?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setAnchorId(current?.anchorVersionId ?? null); }, [selectedId, current == null]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setFrameCount(current?.frameCount ?? 4); }, [selectedId, current == null]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setDirection(current?.direction ?? ''); }, [selectedId, current == null]); // eslint-disable-line react-hooks/exhaustive-deps

  // Registration: flush pending edits, then bake newly aligned BASE-frame versions.
  const alignFrames = useCallback(async (
    anchorX: anim.AnchorX,
    anchorY: anim.AnchorY,
    scope: anim.AlignScope,
  ) => {
    if (!current || aligning) return;
    const animationId = current.id;
    const targetIndex = scope === 'current' ? Math.max(0, Math.min(model.gridLen - 1, frameIdx)) : null;
    if (targetIndex != null && !model.cellAt(0, targetIndex)) {
      setError(t('animate.align.noCurrentFrame'));
      return;
    }
    setAligning(true);
    setError(null);
    try {
      await flushPendingSave();
      const updated = await anim.alignFrames(animationId, {
        anchorX,
        anchorY,
        ...(targetIndex != null ? { frameIndexes: [targetIndex] } : {}),
      });
      if (selectedIdRef.current !== animationId || assetIdRef.current !== asset.id) return;
      applyServer(updated);
      refreshVersions();
      const savedFrame = targetIndex != null
        ? updated.frames.find((f) => f.track === 0 && f.frameIndex === targetIndex)
        : updated.frames.find((f) => f.track === 0);
      onSaved(asset.id, savedFrame?.versionId ?? 0);
      toast.success(t(targetIndex != null ? 'animate.align.doneCurrent' : 'animate.align.doneAll'));
    } catch (e) {
      if (selectedIdRef.current === animationId && assetIdRef.current === asset.id) setError((e as Error).message);
    } finally {
      setAligning(false);
    }
  }, [current, aligning, model, frameIdx, flushPendingSave, applyServer, refreshVersions, onSaved, asset.id, t]);

  const repositionFrame = useCallback(async (dx: number, dy: number) => {
    if (!current || repositioning) return;
    const animationId = current.id;
    const targetIndex = Math.max(0, Math.min(model.gridLen - 1, frameIdx));
    if (!model.cellAt(0, targetIndex)) {
      setError(t('animate.reposition.noCurrentFrame'));
      return;
    }
    setRepositioning(true);
    setError(null);
    try {
      await flushPendingSave();
      const updated = await anim.repositionFrame(animationId, { frameIndex: targetIndex, dx, dy });
      if (selectedIdRef.current !== animationId || assetIdRef.current !== asset.id) return;
      applyServer(updated);
      refreshVersions();
      const savedFrame = updated.frames.find((f) => f.track === 0 && f.frameIndex === targetIndex);
      onSaved(asset.id, savedFrame?.versionId ?? 0);
      toast.success(t('animate.reposition.done'));
    } catch (e) {
      if (selectedIdRef.current === animationId && assetIdRef.current === asset.id) setError((e as Error).message);
    } finally {
      setRepositioning(false);
    }
  }, [current, repositioning, model, frameIdx, flushPendingSave, applyServer, refreshVersions, onSaved, asset.id, t]);

  const patchAnim = useCallback((patch: { fps?: number; loopMode?: anim.AnimLoopMode }) => {
    if (!current) return;
    void anim.patchAnimation(current.id, patch).then(applyServer).catch((e) => setError((e as Error).message));
  }, [current, applyServer]);

  const setLoopRange = useCallback((loopStart: number | null, loopEnd: number | null) => {
    if (!current) return;
    void anim.patchAnimation(current.id, { loopStart, loopEnd }).then(applyServer).catch((e) => setError((e as Error).message));
  }, [current, applyServer]);

  // Track CRUD — server responds with the full DTO; draft re-syncs via reset.
  const trackCall = useCallback((p: Promise<anim.SpriteAnimation>) => {
    p.then((updated) => { applyServer(updated); resetForAnimation(updated.frames); })
      .catch((e) => setError((e as Error).message));
  }, [applyServer, resetForAnimation]);

  const toggleTrackVisible = useCallback((id: number, visible: boolean) => {
    if (!current) return;
    trackCall(anim.patchTrack(current.id, id, { visible }));
  }, [current, trackCall]);

  // Publish the track + loaded-animation context to the RIGHT-rail inspector
  // (which lives in a separate panel) so it can show layer separation + a
  // re-slice that targets the loaded animation.
  const inspectorTracks = useMemo(
    () => (current
      ? tracks.map((tr) => ({
          id: tr.id, name: tr.name, visible: tr.visible,
          count: model.trackCells(tr.id).filter(Boolean).length,
        }))
      : []),
    [current, tracks, model],
  );
  const animContext = useMemo<AnimContext | null>(
    () => (current ? {
      animationId: current.id,
      assetId: asset.id,
      name: current.name,
      jobId: lastGenGroup?.jobId ?? null,
      frameCount: lastGenGroup?.frameCount ?? current.frameCount ?? Math.max(1, model.gridLen),
      hasSheet: lastGenGroup?.hasSheet === true,
    } : null),
    [current, asset.id, lastGenGroup, model.gridLen],
  );
  useEffect(() => {
    // Content-guard: inspectorTracks/animContext are memoized on `model`/
    // `current` IDENTITY, which churns on every frames edit — writing equal
    // content into the store would re-render every bridge subscriber for
    // nothing. Publish only the fields whose CONTENT actually changed.
    const s = useAnimateSession.getState();
    const patch: Parameters<typeof s.publishBridge>[0] = {};
    const sameTracks = s.inspectorTracks.length === inspectorTracks.length
      && s.inspectorTracks.every((tr, i) => {
        const n = inspectorTracks[i];
        return tr.id === n.id && tr.name === n.name && tr.visible === n.visible && tr.count === n.count;
      });
    if (!sameTracks) patch.inspectorTracks = inspectorTracks;
    if (s.activeTrack !== activeTrack) patch.activeTrack = activeTrack;
    const a = s.animContext;
    const b = animContext;
    const sameCtx = a === b || (!!a && !!b && a.animationId === b.animationId
      && a.assetId === b.assetId && a.name === b.name
      && a.jobId === b.jobId && a.frameCount === b.frameCount && a.hasSheet === b.hasSheet);
    if (!sameCtx) patch.animContext = animContext;
    if (s.onActivateTrack !== setActiveTrack) patch.onActivateTrack = setActiveTrack;
    if (s.onToggleTrackVisible !== toggleTrackVisible) patch.onToggleTrackVisible = toggleTrackVisible;
    if (Object.keys(patch).length > 0) s.publishBridge(patch);
  }, [inspectorTracks, activeTrack, animContext, toggleTrackVisible]);
  useEffect(() => {
    useAnimateSession.getState().publishBridge({
      timelineCanUndo: canUndo, timelineCanRedo: canRedo, timelineUndo: undo, timelineRedo: redo,
    });
  }, [canUndo, canRedo, undo, redo]);
  // Unmount: drop the published callbacks/context so the module-level store
  // doesn't retain closures over an unmounted panel.
  useEffect(() => () => {
    useAnimateSession.getState().publishBridge({
      inspectorTracks: [], animContext: null, onActivateTrack: null, onToggleTrackVisible: null,
      timelineCanUndo: false, timelineCanRedo: false, timelineUndo: null, timelineRedo: null,
    });
  }, []);

  // Stable cell-select callback — the inline version changed identity every
  // render, defeating FrameCell's memo through TrackRow.
  const onSelectCell = useCallback((track: number, col: number) => {
    setActiveTrack(track);
    setFrameIdx(() => col);
  }, [setFrameIdx]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <AnimHeader
        animations={animations}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onCreate={async (input) => {
          const created = await anim.createAnimation(projectId, asset.id, input);
          setAnimations((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
          setSelectedId(created.id);
        }}
        onDelete={async (id) => {
          await anim.deleteAnimation(id);
          setAnimations((prev) => prev.filter((a) => a.id !== id));
          if (selectedId === id) setSelectedId(null);
        }}
        onExport={onExportAnimation}
      />
      {current ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
          <GenerateBar
            projectId={projectId}
            assetId={asset.id}
            running={running}
            adopting={adopting}
            hasFrames={model.gridLen > 0}
            direction={direction}
            genStatus={genState && !failed && genState.status !== 'done'
              ? { status: genState.status, pct: genState.pct } : null}
            anchorVersionId={anchorId}
            lastGenJobId={current.lastGenJobId}
            versionById={versionById}
            frameCount={frameCount}
            onDirection={setDirection}
            onAnchorChange={setAnchorId}
            onGenerate={generate}
            onFrameCount={setFrameCount}
          />
          {(error || failed) && (
            <div className="rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] text-red-400">
              {error ?? genState?.error ?? t('animate.generateFailed')}
            </div>
          )}
          <PreviewCanvas
            projectId={projectId}
            frames={frames}
            tracks={tracks}
            fps={current.fps}
            loopMode={current.loopMode}
            selectedIndex={frameIdx}
            loopStart={current.loopStart}
            loopEnd={current.loopEnd}
            versionById={versionById}
            repositioning={repositioning}
            onPatch={patchAnim}
            onScrub={(i) => setFrameIdx(() => i)}
            onSetLoop={setLoopRange}
            onRepositionFrame={repositionFrame}
          />
          <TimelineStrip
            projectId={projectId}
            assetId={asset.id}
            model={model}
            fps={current.fps}
            activeTrack={activeTrack}
            selectedIndex={frameIdx}
            aligning={aligning}
            versionById={versionById}
            onSelect={onSelectCell}
            onAlign={(ax, ay, scope) => void alignFrames(ax, ay, scope)}
            onEditVersion={onEditVersion}
            onReverse={ops.reverse}
            onCopy={ops.copyColumn}
            onPaste={ops.pasteColumn}
            onSetCell={ops.setCellAt}
            onClearCell={ops.clearCellAt}
            onDuration={ops.setDuration}
            onColumnDrag={ops.columnDrag}
            onCellDrag={ops.cellDrag}
            onDuplicateColumn={ops.duplicateColumnAt}
            onActivateTrack={setActiveTrack}
            onAddTrack={() => trackCall(anim.addTrack(current.id))}
            onRenameTrack={(id, name) => trackCall(anim.patchTrack(current.id, id, { name }))}
            onToggleVisible={(id, visible) => trackCall(anim.patchTrack(current.id, id, { visible }))}
            onDeleteTrack={(id) => {
              if (activeTrack === id) setActiveTrack(0);
              trackCall(anim.deleteTrack(current.id, id));
            }}
            onAppend={ops.appendVersion}
          />
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-muted-foreground">
          {t('animate.empty')}
        </div>
      )}
    </div>
  );
}
