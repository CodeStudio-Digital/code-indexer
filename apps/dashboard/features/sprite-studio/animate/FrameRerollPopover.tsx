/**
 * Per-frame re-roll: regenerate just the selected frame without redoing the
 * whole animation. Reuses the generic generate→pick flow — kicks off a small
 * n=4 job conditioned on the frame's own version (identity reference), shows
 * the candidates, and on pick repoints THAT frame at the promoted version via
 * the session bridge (replaceFrameAt). The heavy job/SSE work lives in the
 * content child so it only runs while the popover is open.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover.js';
import { pickCandidate } from '../api.js';
import { useSpriteJobs } from '../jobs/useSpriteJobs.js';
import { useAnimateSession } from './animate-session-store.js';

const TERMINAL = new Set(['done', 'failed', 'cancelled']);

export function FrameRerollPopover({
  projectId,
  assetId,
  versionId,
  prompt,
  refresh,
  children,
}: {
  projectId: number;
  assetId: string;
  versionId: string;
  prompt: string | null;
  refresh: () => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<{ index: number; track: number; versionId: string } | null>(null);
  const onOpenChange = (next: boolean) => {
    if (next) {
      const s = useAnimateSession.getState();
      setTarget(s.selectedFrameIndex == null ? null : { index: s.selectedFrameIndex, track: s.activeTrack, versionId });
    }
    setOpen(next);
  };
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-64 p-2" onClick={(e) => e.stopPropagation()}>
        {open && (
          <RerollContent
            projectId={projectId}
            assetId={assetId}
            versionId={versionId}
            prompt={prompt}
            refresh={refresh}
            target={target}
            onClose={() => setOpen(false)}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

function RerollContent({
  projectId, assetId, versionId, prompt, refresh, target, onClose,
}: {
  projectId: number;
  assetId: string;
  versionId: string;
  prompt: string | null;
  refresh: () => void;
  target: { index: number; track: number; versionId: string } | null;
  onClose: () => void;
}) {
  const { t } = useTranslation('spriteStudio');
  const { jobs, start } = useSpriteJobs(projectId);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const sourceVersionId = target?.versionId ?? versionId;
    void start({
      kind: 'generation', assetId, prompt: prompt || t('animate.rerollPrompt'),
      n: 4, referenceIds: [sourceVersionId], rawPrompt: true,
    }).then(setJobId).catch((e) => setError((e as Error).message));
  }, [start, assetId, prompt, target?.versionId, versionId, t]);

  const state = jobId != null ? jobs.get(jobId) : undefined;
  const candidates = state?.candidates ?? [];
  const running = jobId == null || (state != null && !TERMINAL.has(state.status));
  const targetChangedMessage = t('animate.rerollTargetChanged', { defaultValue: 'Frame changed — reopen re-roll.' });
  const targetMatches = (s: ReturnType<typeof useAnimateSession.getState>) => target != null
    && s.selectedFrameIndex === target.index
    && s.activeTrack === target.track
    && s.selectedFrameVersionId === target.versionId;

  const pick = async (candidateIndex: number) => {
    if (jobId == null || picking || target == null) return;
    const stableTarget = target;
    const before = useAnimateSession.getState();
    if (!targetMatches(before) || before.replaceFrameAt == null) {
      setError(targetChangedMessage);
      return;
    }
    setPicking(true);
    try {
      const version = await pickCandidate(projectId, assetId, jobId, candidateIndex);
      const s = useAnimateSession.getState();
      if (!targetMatches(s) || s.replaceFrameAt == null) {
        refresh();
        setError(targetChangedMessage);
        return;
      }
      s.replaceFrameAt(stableTarget.index, version.id, stableTarget.track, stableTarget.versionId);
      refresh();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPicking(false);
    }
  };

  return (
    <div>
      <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {t('animate.reroll')}
      </div>
      {error ? (
        <div className="rounded border border-red-500/30 bg-red-500/10 px-1.5 py-1 text-[10px] text-red-400">{error}</div>
      ) : candidates.length === 0 ? (
        <div className="flex items-center justify-center gap-1 py-4 text-[10px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t(`animate.jobStatus.${state?.status ?? 'queued'}`, { defaultValue: t('animate.generating') })}
          {state?.pct ? ` · ${state.pct}%` : ''}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-1.5">
          {candidates.map((c) => (
            <button
              key={c.index}
              type="button"
              disabled={picking}
              onClick={() => void pick(c.index)}
              className="relative aspect-square overflow-hidden rounded border border-border bg-muted/40 hover:border-primary disabled:opacity-50"
            >
              <img src={c.thumbUrl} alt={`#${c.index}`} className="h-full w-full object-contain" style={{ imageRendering: 'pixelated' }} draggable={false} />
            </button>
          ))}
        </div>
      )}
      {running && candidates.length > 0 && (
        <div className="mt-1 text-center text-[9px] text-muted-foreground">{t('animate.rerollMore')}</div>
      )}
    </div>
  );
}
