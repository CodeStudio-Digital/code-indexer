/**
 * GeneratePanel — the center surface in generate mode. Composes StyleChips +
 * PromptComposer + VariantsGrid, owns the `useSpriteJobs(projectId)` hook and
 * the "current generation job" pointer, and opens SaveVariantDialog when a
 * candidate is picked.
 *
 * Props (mounted by SpriteStudioView / the orchestrator):
 *   projectId:   number                 — active IDE project id
 *   settings:    StudioSettings         — project style settings (read-only here)
 *   activeAsset: SpriteAsset | null      — selected library asset, if any
 *   onSaved:     (assetId, versionId) => void
 *                — called after a candidate is promoted to a version, so the
 *                  parent can refresh the library + reselect the asset/version.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleChips } from './StyleChips.js';
import { PromptComposer, type GenerateInput } from './PromptComposer.js';
import { RefSlots, MAX_REFS, type GenRef } from './RefSlots.js';
import { VariantsGrid } from './VariantsGrid.js';
import { SaveVariantDialog } from './SaveVariantDialog.js';
import { useSpriteJobs, type JobCandidate } from '../jobs/useSpriteJobs.js';
import { candidateThumbUrl } from '../api.js';
import { loadSpriteStudioUi, saveSpriteStudioUi } from '../sprite-studio-ui-state.js';
import type { GenerationJobParams } from '../jobs/job-types.js';
import type { SpriteAsset, StudioSettings } from '../types.js';

/** External "iterate from this" request (version list / variant card). */
export type IterateRef =
  | { kind: 'version'; versionId: number; label: string }
  | { kind: 'candidate'; jobId: number; index: number };

/** Backend job lifecycle names (see @mcp/store SpriteJobStatus). */
const ACTIVE_STATUSES = new Set(['queued', 'prompting', 'generating', 'postprocess', 'saving']);

export function GeneratePanel({
  projectId,
  settings,
  activeAsset,
  onSaved,
  iterateRef,
  onIterateConsumed,
}: {
  projectId: number;
  settings: StudioSettings | null;
  activeAsset: SpriteAsset | null;
  onSaved: (assetId: number, versionId: number) => void;
  /** "Iterate from this" request injected by the orchestrator (version list). */
  iterateRef?: IterateRef | null;
  onIterateConsumed?: () => void;
}) {
  const { t } = useTranslation('spriteStudio');
  const { jobs, start, restore } = useSpriteJobs(projectId);

  // Reference conditioning (the fidelity path). Auto-ref: the asset's current
  // version rides as the identity anchor unless the user opts out.
  const [refs, setRefs] = useState<GenRef[]>([]);
  const [useCurrentAsRef, setUseCurrentAsRef] = useState(true);
  const hasAutoRef = useCurrentAsRef && activeAsset?.currentVersionId != null;

  const [currentJobId, setCurrentJobId] = useState<number | null>(null);
  // Params of the current job, kept for Re-roll (re-run with same settings).
  const [lastParams, setLastParams] = useState<GenerateInput | null>(null);
  const [discarded, setDiscarded] = useState<Set<number>>(new Set());
  const [saveCandidate, setSaveCandidate] = useState<JobCandidate | null>(null);

  // Remount rehydration: the last generation of this project is restored from
  // localStorage + the backend (job row + candidates on disk), so navigating
  // away mid-batch never throws the tokens away.
  const restoredFor = useRef<number | null>(null);
  useEffect(() => {
    if (restoredFor.current === projectId) return;
    restoredFor.current = projectId;
    setCurrentJobId(null);
    setLastParams(null);
    setDiscarded(new Set());
    const saved = loadSpriteStudioUi(projectId)?.lastGenJob;
    if (!saved) return;
    setLastParams({ prompt: saved.prompt, n: saved.n, rawPrompt: saved.rawPrompt, seed: saved.seed });
    void restore(saved.jobId).then((state) => {
      if (restoredFor.current !== projectId) return;
      if (state) setCurrentJobId(saved.jobId);
      else saveSpriteStudioUi(projectId, { lastGenJob: null }); // job pruned server-side
    });
  }, [projectId, restore]);

  const job = currentJobId != null ? jobs.get(currentJobId) ?? null : null;
  const running = job != null && ACTIVE_STATUSES.has(job.status);

  // "Iterate from this" — the conversational-refinement pattern of the web
  // UIs: the chosen image becomes a reference for the next run. A scratch
  // candidate has no version row, so its PNG rides as an upload ref.
  const addVersionRef = useCallback((versionId: number, label: string) => {
    setRefs((prev) => prev.length >= MAX_REFS || prev.some((r) => r.kind === 'version' && r.versionId === versionId)
      ? prev
      : [...prev, { kind: 'version', versionId, label }]);
  }, []);

  const addCandidateRef = useCallback(async (jobId: number, index: number) => {
    const res = await fetch(candidateThumbUrl(jobId, index));
    if (!res.ok) return;
    const blob = await res.blob();
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as string);
      r.onerror = () => reject(new Error('read failed'));
      r.readAsDataURL(blob);
    });
    setRefs((prev) => prev.length >= MAX_REFS ? prev : [
      ...prev,
      {
        kind: 'upload',
        base64: dataUrl.slice(dataUrl.indexOf(',') + 1),
        mediaType: 'image/png',
        label: t('generate.refs.candidateLabel'),
        dataUrl,
      },
    ]);
  }, [t]);

  useEffect(() => {
    if (!iterateRef) return;
    void (async () => {
      try {
        if (iterateRef.kind === 'version') addVersionRef(iterateRef.versionId, iterateRef.label);
        else await addCandidateRef(iterateRef.jobId, iterateRef.index);
      } finally {
        onIterateConsumed?.();
      }
    })();
  }, [iterateRef, onIterateConsumed, addVersionRef, addCandidateRef]);

  const run = useCallback(async (input: GenerateInput) => {
    const params: GenerationJobParams = {
      kind: 'generation',
      prompt: input.prompt,
      n: input.n,
      rawPrompt: input.rawPrompt,
      seed: input.seed,
      assetId: activeAsset?.id,
      size: settings ? { width: settings.canvas.width, height: settings.canvas.height } : undefined,
      useCurrentAsRef: hasAutoRef,
      referenceIds: refs.filter((r) => r.kind === 'version').map((r) => (r as { versionId: number }).versionId),
      uploadRefs: refs
        .filter((r): r is Extract<GenRef, { kind: 'upload' }> => r.kind === 'upload')
        .map((r) => ({ base64: r.base64, mediaType: r.mediaType })),
    };
    setDiscarded(new Set());
    setLastParams(input);
    const jobId = await start(params);
    setCurrentJobId(jobId);
    saveSpriteStudioUi(projectId, {
      lastGenJob: { jobId, prompt: input.prompt, n: input.n, rawPrompt: input.rawPrompt, seed: input.seed },
    });
  }, [activeAsset?.id, settings, start, projectId, hasAutoRef, refs]);

  const reroll = useCallback(() => {
    if (lastParams) void run(lastParams);
  }, [lastParams, run]);

  const discard = useCallback((index: number) => {
    setDiscarded((prev) => new Set(prev).add(index));
  }, []);

  const handleSaved = useCallback((assetId: number, versionId: number) => {
    setSaveCandidate(null);
    onSaved(assetId, versionId);
  }, [onSaved]);

  const expectedCount = lastParams?.n ?? 4;
  const promptForSave = useMemo(() => lastParams?.prompt ?? '', [lastParams]);
  // Synchronous read (localStorage) so the composer initializes restored.
  const initialDraft = useMemo(() => loadSpriteStudioUi(projectId)?.composerDraft ?? null, [projectId]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3">
      <div className="space-y-2">
        <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {t('generate.style')}
        </div>
        <StyleChips settings={settings} />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <RefSlots projectId={projectId} refs={refs} onChange={setRefs} />
        {activeAsset?.currentVersionId != null && (
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              checked={useCurrentAsRef}
              onChange={(e) => setUseCurrentAsRef(e.target.checked)}
              className="h-3.5 w-3.5 accent-primary"
            />
            {t('generate.refs.useCurrent', { name: activeAsset.name })}
          </label>
        )}
        {(hasAutoRef || refs.length > 0) && (
          <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
            {t('generate.refs.fidelityChip')}
          </span>
        )}
      </div>

      <PromptComposer
        key={projectId}
        running={running}
        onGenerate={(i) => void run(i)}
        initialDraft={initialDraft}
        onDraftChange={(d) => saveSpriteStudioUi(projectId, { composerDraft: d })}
      />

      <div className="flex min-h-0 flex-1 flex-col">
        <VariantsGrid
          job={job}
          expectedCount={expectedCount}
          discarded={discarded}
          onPick={setSaveCandidate}
          onReroll={reroll}
          onDiscard={discard}
          onIterate={
            currentJobId != null
              ? (c) => void addCandidateRef(currentJobId, c.index)
              : undefined
          }
        />
      </div>

      <SaveVariantDialog
        open={saveCandidate != null}
        onOpenChange={(v) => { if (!v) setSaveCandidate(null); }}
        projectId={projectId}
        jobId={currentJobId ?? -1}
        candidate={saveCandidate}
        prompt={promptForSave}
        settings={settings}
        activeAsset={activeAsset}
        onSaved={handleSaved}
      />
    </div>
  );
}
