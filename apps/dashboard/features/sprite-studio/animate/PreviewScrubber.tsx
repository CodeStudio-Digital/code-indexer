/**
 * Playback scrubber for the PreviewCanvas: a draggable track that scrubs the
 * playhead (onScrub) plus loop in/out markers. The moving playhead element is
 * positioned imperatively by PreviewCanvas via `headRef` (no per-frame React
 * re-render); this component owns the track geometry, the shaded loop region
 * and the set-in / set-out / clear controls.
 */
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Brackets, X } from 'lucide-react';

export function PreviewScrubber({
  n,
  loopStart,
  loopEnd,
  currentIndex,
  headRef,
  onScrub,
  onSetLoop,
}: {
  n: number;
  loopStart: number | null;
  loopEnd: number | null;
  currentIndex: number;
  headRef: React.RefObject<HTMLDivElement | null>;
  onScrub: (i: number) => void;
  onSetLoop: (start: number | null, end: number | null) => void;
}) {
  const { t } = useTranslation('spriteStudio');
  const trackRef = useRef<HTMLDivElement>(null);
  if (n <= 1) return null;

  const idxFromX = (clientX: number): number => {
    const r = trackRef.current?.getBoundingClientRect();
    if (!r || r.width === 0) return 0;
    const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    return Math.round(f * (n - 1));
  };
  const onDown = (e: React.PointerEvent) => {
    onScrub(idxFromX(e.clientX));
    const move = (ev: PointerEvent) => onScrub(idxFromX(ev.clientX));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const hasLoop = loopStart != null || loopEnd != null;
  const lo = Math.max(0, loopStart ?? 0);
  const hi = Math.min(n - 1, loopEnd ?? n - 1);
  const pct = (i: number) => `${(i / (n - 1)) * 100}%`;

  return (
    <div className="flex items-center gap-1.5">
      <div ref={trackRef} onPointerDown={onDown} className="relative h-4 flex-1 cursor-pointer rounded bg-muted">
        {hasLoop && hi >= lo && (
          <div className="absolute top-0 h-full rounded bg-primary/25" style={{ left: pct(lo), width: `${((hi - lo) / (n - 1)) * 100}%` }} />
        )}
        {/* Playhead — positioned imperatively by PreviewCanvas via headRef. */}
        <div ref={headRef} className="pointer-events-none absolute top-[-2px] h-5 w-0.5 -translate-x-1/2 rounded bg-primary" style={{ left: pct(Math.max(0, Math.min(n - 1, currentIndex))) }} />
      </div>
      <button type="button" title={t('animate.loop.setIn')} onClick={() => onSetLoop(currentIndex, loopEnd)}
        className="rounded p-0.5 text-muted-foreground hover:text-foreground">
        <Brackets className="h-3 w-3" />
      </button>
      <button type="button" title={t('animate.loop.setOut')} onClick={() => onSetLoop(loopStart, currentIndex)}
        className="rounded p-0.5 text-muted-foreground hover:text-foreground">
        <Brackets className="h-3 w-3 scale-x-[-1]" />
      </button>
      {hasLoop && (
        <button type="button" title={t('animate.loop.clear')} onClick={() => onSetLoop(null, null)}
          className="rounded p-0.5 text-muted-foreground hover:text-foreground">
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
