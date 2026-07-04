/**
 * EnhanceResultsStrip — live follow view for ONE inpaint/enhance job:
 * progress (status/pct) while it runs, candidate thumbs as their
 * `sprite_variant_ready` events land, and a per-candidate Apply that promotes
 * the pick into a new asset version (pickCandidate) without leaving the mode.
 *
 * The owner (AiEditBar / EnhanceCard) instantiates useSpriteJobs and hands it
 * in via `jobs` — the strip never opens SSE streams itself. On mount it calls
 * jobs.restore(jobId): the owner's SSE may connect only after the job started
 * (the hook goes live when a projectId becomes known), and restore backfills
 * the row + any candidates already staged on disk; the bus replay covers the
 * rest.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, Loader2, X } from 'lucide-react';
import { toast } from '../../../components/ui/prompt-dialog.js';
import { Button } from '../../../components/ui/button.js';
import { pickCandidate } from '../api.js';
import type { UseSpriteJobs } from '../jobs/useSpriteJobs.js';

const TERMINAL = new Set(['done', 'failed', 'cancelled']);

/** Pure-CSS transparent checkerboard (same trick as VariantCard). */
const CHECKERBOARD: React.CSSProperties = {
  backgroundImage:
    'conic-gradient(rgba(128,128,128,0.18) 0 25%, transparent 0 50%, rgba(128,128,128,0.18) 0 75%, transparent 0)',
  backgroundSize: '12px 12px',
};

export function EnhanceResultsStrip({
  projectId,
  assetId,
  jobId,
  jobs,
  onApplied,
  onClose,
}: {
  projectId: number;
  assetId: number;
  jobId: number;
  /** Live job feed owned by the mounting component (one SSE per owner). */
  jobs: UseSpriteJobs;
  /** Fires with the NEW version id after a candidate is applied. */
  onApplied?: (versionId: number) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('spriteStudio');
  const [applying, setApplying] = useState<number | null>(null);
  const [applied, setApplied] = useState<ReadonlySet<number>>(new Set());

  const { restore } = jobs;
  useEffect(() => { void restore(jobId); }, [jobId, restore]);

  const job = jobs.jobs.get(jobId) ?? jobs.get(jobId);
  const status = job?.status ?? 'queued';
  // The runner emits 'postprocess' on the wire (store union) while the
  // frontend union/catalog says 'post-processing' — normalize for the lookup.
  const statusKey = (status as string) === 'postprocess' ? 'post-processing' : status;
  const terminal = TERMINAL.has(status);
  const candidates = job?.candidates ?? [];

  const apply = async (index: number) => {
    if (applying !== null) return;
    setApplying(index);
    try {
      const version = await pickCandidate(projectId, assetId, jobId, index);
      setApplied((prev) => new Set(prev).add(index));
      toast.success(t('enhance.appliedTitle'), { description: t('enhance.appliedBody') });
      onApplied?.(version.id);
    } catch (e) {
      toast.error(t('enhance.applyFailed'), { description: (e as Error).message });
    } finally {
      setApplying(null);
    }
  };

  return (
    <div className="space-y-1.5 px-2 py-1.5">
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        {status === 'failed' ? (
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-400" />
        ) : !terminal ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
        ) : (
          <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
        )}
        <span className="truncate">
          {status === 'failed'
            ? t('enhance.failed')
            : job?.note ?? t(`generate.status.${statusKey}`)}
        </span>
        {!terminal && (
          <div className="h-1 min-w-10 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${Math.max(5, Math.min(100, job?.pct ?? 0))}%` }}
            />
          </div>
        )}
        {!terminal && (
          <Button
            size="sm" variant="ghost" className="h-5 px-1.5 text-[10px]"
            onClick={() => void jobs.cancel(jobId)}
          >
            {t('enhance.cancel')}
          </Button>
        )}
        <Button
          size="sm" variant="ghost" className="ml-auto h-5 w-5 shrink-0 p-0"
          title={t('enhance.close')} aria-label={t('enhance.close')} onClick={onClose}
        >
          <X className="h-3 w-3" />
        </Button>
      </div>

      {status === 'failed' && job?.error && (
        <div className="max-h-16 overflow-y-auto break-words text-[11px] text-red-400">
          {job.error}
        </div>
      )}

      {candidates.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {candidates.map((cnd) => (
            <div key={cnd.candidateId} className="flex w-20 flex-col overflow-hidden rounded border">
              <div className="flex h-16 items-center justify-center overflow-hidden" style={CHECKERBOARD}>
                <img
                  src={cnd.thumbUrl}
                  alt={t('enhance.candidateAlt', { n: cnd.index + 1 })}
                  className="max-h-full max-w-full object-contain"
                  style={{ imageRendering: 'pixelated' }}
                />
              </div>
              <Button
                size="sm"
                variant={applied.has(cnd.index) ? 'outline' : 'default'}
                className="h-5 gap-1 rounded-none text-[10px]"
                disabled={applying !== null}
                title={applying === cnd.index ? t('enhance.applying') : t('enhance.apply')}
                onClick={() => void apply(cnd.index)}
              >
                {applying === cnd.index ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : applied.has(cnd.index) ? (
                  <><Check className="h-3 w-3" /> {t('enhance.appliedShort')}</>
                ) : (
                  t('enhance.apply')
                )}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
