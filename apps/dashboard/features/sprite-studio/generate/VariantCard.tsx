/**
 * VariantCard — one finished candidate from a generation job. Shows a
 * checkerboard-backed preview (click to zoom), and on hover exposes Pick
 * (→ SaveVariantDialog upstream), Re-roll (re-run the same params) and
 * Discard actions.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, RefreshCw, Wand2, X, ZoomIn } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { cn } from '../../../lib/utils.js';
import type { JobCandidate } from '../jobs/useSpriteJobs.js';

/** Pure-CSS transparent checkerboard (no asset request). */
const CHECKERBOARD: React.CSSProperties = {
  backgroundImage:
    'conic-gradient(rgba(128,128,128,0.18) 0 25%, transparent 0 50%, rgba(128,128,128,0.18) 0 75%, transparent 0)',
  backgroundSize: '16px 16px',
};

export function VariantCard({
  candidate,
  discarded,
  onPick,
  onReroll,
  onDiscard,
  onIterate,
}: {
  candidate: JobCandidate;
  discarded: boolean;
  onPick: (candidate: JobCandidate) => void;
  onReroll: () => void;
  onDiscard: (index: number) => void;
  /** "Iterate from this": attach the candidate as a reference for the next run. */
  onIterate?: (candidate: JobCandidate) => void;
}) {
  const { t } = useTranslation('spriteStudio');
  const [zoom, setZoom] = useState(false);

  return (
    <div
      className={cn(
        'group relative flex flex-col overflow-hidden rounded border transition-opacity',
        discarded && 'opacity-40',
      )}
    >
      <div
        className="relative flex h-32 items-center justify-center overflow-hidden"
        style={CHECKERBOARD}
      >
        <img
          src={candidate.thumbUrl}
          alt={t('generate.variants.candidateAlt', { n: candidate.index + 1 })}
          className={cn('object-contain transition-transform', zoom ? 'scale-[2.2]' : 'max-h-full max-w-full')}
          style={{ imageRendering: 'pixelated' }}
        />
        <button
          type="button"
          onClick={() => setZoom((v) => !v)}
          title={t('generate.variants.zoom')}
          className="absolute right-1 top-1 rounded bg-background/70 p-1 opacity-0 transition-opacity hover:bg-background group-hover:opacity-100"
        >
          <ZoomIn className="h-3.5 w-3.5" />
        </button>
      </div>
      {!discarded && (
        <div className="flex items-center gap-1 border-t p-1">
          <Button size="sm" className="h-6 flex-1 gap-1 px-2 text-[11px]" onClick={() => onPick(candidate)}>
            <Check className="h-3 w-3" /> {t('generate.variants.pick')}
          </Button>
          {onIterate && (
            <Button
              size="icon-sm"
              variant="ghost"
              className="h-6 w-6"
              title={t('generate.variants.iterate')}
              onClick={() => onIterate(candidate)}
            >
              <Wand2 className="h-3 w-3" />
            </Button>
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            className="h-6 w-6"
            title={t('generate.variants.reroll')}
            onClick={onReroll}
          >
            <RefreshCw className="h-3 w-3" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            className="h-6 w-6"
            title={t('generate.variants.discard')}
            onClick={() => onDiscard(candidate.index)}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}
    </div>
  );
}
