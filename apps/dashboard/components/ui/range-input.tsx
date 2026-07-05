/**
 * Slider + typeable numeric field, kept in sync — so any range control can also
 * take an exact value by keyboard (not just by dragging). The text field holds a
 * local draft while focused (so partial/empty input doesn't fight the user),
 * commits in-range values live, and clamps to [min,max] on blur / Enter.
 * Escape reverts the draft. Mirrors the editor zoom readout's behaviour.
 */
import { useState } from 'react';
import { cn } from '../../lib/utils.js';

interface RangeInputProps {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  label?: React.ReactNode;
  /** Unit shown after the number field (e.g. '%', 'px'). */
  suffix?: string;
  disabled?: boolean;
  sliderClassName?: string;
  numberClassName?: string;
  labelClassName?: string;
  className?: string;
  'aria-label'?: string;
}

export function RangeInput({
  value, onChange, min, max, step = 1, label, suffix, disabled,
  sliderClassName, numberClassName, labelClassName, className, 'aria-label': ariaLabel,
}: RangeInputProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const a11y = ariaLabel ?? (typeof label === 'string' ? label : undefined);

  const clamp = (n: number): number => {
    const snapped = step > 0 ? Math.round(n / step) * step : n;
    return Math.min(max, Math.max(min, snapped));
  };
  const commit = () => {
    if (draft == null) return;
    const n = Number(draft);
    onChange(Number.isFinite(n) && draft.trim() !== '' ? clamp(n) : value);
    setDraft(null);
  };

  return (
    <label className={cn('flex items-center gap-1.5', className)}>
      {label != null && <span className={cn('shrink-0', labelClassName)}>{label}</span>}
      <input
        type="range" min={min} max={max} step={step} value={value} disabled={disabled}
        aria-label={a11y}
        onChange={(e) => onChange(clamp(Number(e.target.value)))}
        className={cn('h-1 cursor-pointer accent-primary disabled:opacity-50', sliderClassName ?? 'w-24')}
      />
      <span className="flex shrink-0 items-center gap-0.5">
        <input
          type="text" inputMode="numeric" value={draft ?? String(value)} disabled={disabled}
          aria-label={a11y}
          onChange={(e) => {
            const raw = e.target.value;
            setDraft(raw);
            const n = Number(raw);
            // Commit live ONLY when the typed value is already exactly valid —
            // in range AND step-aligned (clamp is a no-op). Otherwise the slider
            // would jump to a snapped value while the field still shows the raw
            // draft; those wait for blur to clamp so the two never disagree.
            if (raw.trim() !== '' && Number.isFinite(n) && clamp(n) === n) onChange(n);
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); e.currentTarget.blur(); }
            else if (e.key === 'Escape') setDraft(null);
          }}
          className={cn(
            'h-4 rounded border border-border bg-transparent px-1 text-right tabular-nums text-foreground outline-none focus:border-primary disabled:opacity-50',
            numberClassName ?? 'w-9',
          )}
        />
        {suffix && <span className="text-muted-foreground">{suffix}</span>}
      </span>
    </label>
  );
}
