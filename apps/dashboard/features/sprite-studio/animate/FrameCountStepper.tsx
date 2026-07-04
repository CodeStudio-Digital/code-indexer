/**
 * Frame-count stepper for the GenerateBar — lets the user set N (2..12) before
 * (re)generating. The raised 12 ceiling matches the backend clampFrames; past
 * ~12 the single-strip frame-pack loses per-pose fidelity.
 */
import { Minus, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

const MIN = 2;
const MAX = 12;
const clamp = (n: number): number => Math.max(MIN, Math.min(MAX, Math.round(n)));

export function FrameCountStepper({
  value,
  disabled,
  onChange,
}: {
  value: number;
  disabled?: boolean;
  onChange: (n: number) => void;
}) {
  const { t } = useTranslation('spriteStudio');
  return (
    <label className="flex items-center gap-1 text-[10px] text-muted-foreground" title={t('animate.framesHint')}>
      {t('animate.framesCount')}
      <span className="flex items-center rounded border">
        <button
          type="button"
          aria-label={t('animate.framesDec')}
          disabled={disabled || value <= MIN}
          onClick={() => onChange(clamp(value - 1))}
          className="flex h-6 w-6 items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-40"
        >
          <Minus className="h-3 w-3" />
        </button>
        <input
          type="number"
          min={MIN}
          max={MAX}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(clamp(Number(e.target.value) || MIN))}
          className="h-6 w-8 border-x bg-background text-center text-[11px] tabular-nums outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
        />
        <button
          type="button"
          aria-label={t('animate.framesInc')}
          disabled={disabled || value >= MAX}
          onClick={() => onChange(clamp(value + 1))}
          className="flex h-6 w-6 items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-40"
        >
          <Plus className="h-3 w-3" />
        </button>
      </span>
    </label>
  );
}
