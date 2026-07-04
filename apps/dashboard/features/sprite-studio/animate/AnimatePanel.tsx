/**
 * AnimatePanel — the phase-2 animation surface: header (select/create), a
 * frame-pack generate bar (job progress over the project SSE bus), the
 * dedicated PreviewCanvas and the TimelineStrip. Export name + props are the
 * CONTRACT CenterSurface mounts against. The heavy lifting lives in hooks:
 * useFrameDraft (timeline draft + debounced PATCH), useAnimGeneration
 * (generate → adopt), useTimelineShortcuts (frame ops + keyboard).
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '../../../components/ui/prompt-dialog.js';
import { useSpriteJobs } from '../jobs/useSpriteJobs.js';
import type { AssetVersion, SpriteAsset, StudioSettings } from '../types.js';
import * as anim from './api-anim.js';
import { AnimHeader } from './AnimHeader.js';
import { GenerateBar } from './GenerateBar.js';
import { PreviewCanvas } from './PreviewCanvas.js';
import { TimelineStrip } from './TimelineStrip.js';
import { useAnimateSession } from './animate-session-store.js';
import { useTimelineShortcuts } from './useTimelineShortcuts.js';
import { useFrameDraft } from './useFrameDraft.js';
import { useAnimGeneration } from './useAnimGeneration.js';

export function AnimatePanel({
  projectId,
  asset,
  // Style is applied server-side (project style contract) — prop kept for the
  // CenterSurface mount contract.
  settings: _settings,
  versionById,
  refreshVersions,
  onSaved,
  onEditVersion,
}: {
  projectId: number;
  asset: SpriteAsset;
  settings: StudioSettings | null;
  /** Shared version lookup (lifted useAssetVersions) — provenance titles. */
  versionById: Map<number, AssetVersion>;
  /** Re-pull the shared version list after adopt/align create new rows. */
  refreshVersions: () => void;
  onSaved: (assetId: number, versionId: number) => void;
  /** Open a frame's version in the editor (wired by CenterSurface/StudioView). */
  onEditVersion?: (versionId: number) => void;
}) {
  const { t } = useTranslation('spriteStudio');
  const { jobs } = useSpriteJobs(projectId);
  const publishBridge = useAnimateSession((s) => s.publishBridge);

  const [animations, setAnimations] = useState<anim.SpriteAnimation[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [frameCount, setFrameCount] = useState(4);
  const [anchorId, setAnchorId] = useState<number | null>(null);
  const [aligning, setAligning] = useState(false);
  const [direction, setDirection] = useState('');
  const [error, setError] = useState<string | null>(null);

  const current = animations.find((a) => a.id === selectedId) ?? null;
  const applyServer = useCallback((updated: anim.SpriteAnimation) => {
    setAnimations((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
  }, []);

  const { frames, frameIdx, setFrameIdx, editFrames, resetForAnimation, flushPendingSave } =
    useFrameDraft(current, applyServer, setError);
  const { generate, running, adopting, failed, genState } = useAnimGeneration({
    current, assetId: asset.id, jobs, direction, anchorId, frameCount,
    applyServer, onSaved, refreshVersions, onError: setError,
  });
  const { reverse, copyFrame, pasteFrame } = useTimelineShortcuts(
    frames, frameIdx, editFrames, setFrameIdx, current != null,
  );

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

  // Reset the frame draft + hydrate anchor/frameCount on animation switch only
  // (locally-picked values must survive PATCH echoes from timeline edits).
  useEffect(() => { resetForAnimation(current?.frames ?? []); }, [selectedId, current?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setAnchorId(current?.anchorVersionId ?? null); }, [selectedId, current == null]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setFrameCount(current?.frameCount ?? 4); }, [selectedId, current == null]); // eslint-disable-line react-hooks/exhaustive-deps

  // Registration: flush any pending timeline edit, then re-anchor every frame.
  const alignAll = useCallback(async (anchorX: anim.AnchorX, anchorY: anim.AnchorY) => {
    if (!current || aligning) return;
    setAligning(true);
    setError(null);
    try {
      await flushPendingSave();
      const updated = await anim.alignFrames(current.id, { anchorX, anchorY });
      applyServer(updated);
      onSaved(asset.id, updated.frames[0]?.versionId ?? 0);
      refreshVersions();
      toast.success(t('animate.align.done'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAligning(false);
    }
  }, [current, aligning, flushPendingSave, applyServer, onSaved, refreshVersions, asset.id, t]);

  const patchAnim = useCallback((patch: { fps?: number; loopMode?: anim.AnimLoopMode }) => {
    if (!current) return;
    void anim.patchAnimation(current.id, patch).then(applyServer).catch((e) => setError((e as Error).message));
  }, [current, applyServer]);

  const setLoopRange = useCallback((loopStart: number | null, loopEnd: number | null) => {
    if (!current) return;
    void anim.patchAnimation(current.id, { loopStart, loopEnd }).then(applyServer).catch((e) => setError((e as Error).message));
  }, [current, applyServer]);

  // Bridge: publish the timeline's versionIds + selected frame + the imperative
  // callbacks the Frames browser / FrameInspector (other rails) call back into.
  useEffect(() => {
    publishBridge({
      frameVersionIds: frames.map((f) => f.versionId),
      selectedFrameVersionId: frames[frameIdx]?.versionId ?? null,
      selectedFrameIndex: frames.length > 0 ? frameIdx : null,
      appendToTimeline: (ids) =>
        editFrames([...frames, ...ids.map((versionId) => ({ id: -1, frameIndex: 0, versionId, durationMs: null }))]),
      removeFramesUsing: (ids) => editFrames(frames.filter((f) => !ids.includes(f.versionId))),
      replaceFrameAt: (i, versionId) => editFrames(frames.map((f, k) => (k === i ? { ...f, versionId } : f))),
      setTimeline: (ids) => editFrames(ids.map((versionId, i) => ({ id: -1, frameIndex: i, versionId, durationMs: null }))),
    });
  }, [frames, frameIdx, editFrames, publishBridge]);
  useEffect(() => () => {
    publishBridge({
      frameVersionIds: [], selectedFrameVersionId: null, selectedFrameIndex: null,
      appendToTimeline: null, removeFramesUsing: null, replaceFrameAt: null, setTimeline: null,
    });
  }, [publishBridge]);

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
      />
      {current ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
          <GenerateBar
            projectId={projectId}
            assetId={asset.id}
            running={running}
            adopting={adopting}
            hasFrames={frames.length > 0}
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
            fps={current.fps}
            loopMode={current.loopMode}
            selectedIndex={frameIdx}
            loopStart={current.loopStart}
            loopEnd={current.loopEnd}
            onPatch={patchAnim}
            onScrub={setFrameIdx}
            onSetLoop={setLoopRange}
          />
          <TimelineStrip
            projectId={projectId}
            assetId={asset.id}
            frames={frames}
            fps={current.fps}
            selectedIndex={frameIdx}
            aligning={aligning}
            versionById={versionById}
            onSelect={setFrameIdx}
            onEdit={editFrames}
            onAlign={(ax, ay) => void alignAll(ax, ay)}
            onEditVersion={onEditVersion}
            onReverse={reverse}
            onCopy={copyFrame}
            onPaste={pasteFrame}
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
