/**
 * VariantsGrid — renders the n cells of the active generation job: a skeleton
 * with a progress bar while a slot is still pending, the candidate preview
 * (VariantCard) once its `sprite_variant_ready` arrives, and a failure state
 * if the job errors. When there's no active job it shows an idle prompt.
 */
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ImageIcon, Sparkles } from 'lucide-react';
import { VariantCard } from './VariantCard.js';
import type { JobCandidate, JobState } from '../jobs/useSpriteJobs.js';

/** Terminal statuses at which no more candidates will arrive. */
const DONE = new Set(['done', 'failed', 'cancelled']);

export function VariantsGrid({
  job,
  expectedCount,
  discarded,
  onPick,
  onReroll,
  onDiscard,
  onIterate,
}: {
  job: JobState | null;
  /** Variant count requested (drives skeleton cell count). */
  expectedCount: number;
  discarded: Set<number>;
  onPick: (candidate: JobCandidate) => void;
  onReroll: () => void;
  onDiscard: (index: number) => void;
  onIterate?: (candidate: JobCandidate) => void;
}) {
  const { t } = useTranslation('spriteStudio');

  if (!job) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded border border-dashed p-8 text-center text-xs text-muted-foreground">
        <Sparkles className="h-7 w-7 opacity-40" />
        {t('generate.variants.idle')}
      </div>
    );
  }

  if (job.status === 'failed') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded border border-red-500/40 bg-red-500/10 p-6 text-center text-xs text-red-400">
        <AlertTriangle className="h-6 w-6" />
        <div className="font-medium">{t('generate.variants.failed')}</div>
        {job.error && <div className="max-w-sm break-words opacity-80">{job.error}</div>}
      </div>
    );
  }

  const done = DONE.has(job.status);
  const cells = Math.max(expectedCount, job.candidates.length);
  const byIndex = new Map(job.candidates.map((c) => [c.index, c]));

  return (
    <div className="grid grid-cols-2 gap-2">
      {Array.from({ length: cells }, (_, i) => {
        const candidate = byIndex.get(i);
        if (candidate) {
          return (
            <VariantCard
              key={candidate.candidateId}
              candidate={candidate}
              discarded={discarded.has(i)}
              onPick={onPick}
              onReroll={onReroll}
              onDiscard={onDiscard}
              onIterate={onIterate}
            />
          );
        }
        // Pending cell: skeleton + progress bar (or an empty slot once done).
        return (
          <div
            key={`skeleton-${i}`}
            className="flex h-[9.5rem] flex-col items-center justify-center gap-2 rounded border border-dashed"
          >
            {done ? (
              <ImageIcon className="h-6 w-6 text-muted-foreground/30" />
            ) : (
              <>
                <div className="h-1.5 w-3/4 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-all"
                    style={{ width: `${Math.max(5, Math.min(100, job.pct))}%` }}
                  />
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {job.note ?? t(`generate.status.${job.status}`)}
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
