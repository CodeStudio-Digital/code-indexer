/**
 * Interactive re-slice overlay: the kept sheet with one draggable box per frame.
 * The uniform grid (cols/rows + offset/margin) gives each cell its default crop;
 * dragging a cell nudges JUST that frame's crop window in source pixels (overlap
 * allowed) so it can recover pixels the even grid would clip. Double-click a cell
 * resets its nudge. All geometry lives in source px and is drawn as % of the
 * natural sheet, so it survives the responsive <img> scaling. Pointer deltas are
 * converted client-px → source-px via the rendered <img> size.
 */
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../../../lib/utils.js';
import { clampResliceNudge, computeResliceLayout, resliceCellRect, type Nudge } from './reslice-geometry.js';

const ZERO: Nudge = { dx: 0, dy: 0 };

export function ResliceOverlay({
  src, alt, nat, onNat, cols, rows, offsetX, offsetY, marginX, marginY,
  offsets, onOffsetsChange, selected, onSelect,
}: {
  src: string;
  alt: string;
  nat: { w: number; h: number } | null;
  onNat: (n: { w: number; h: number }) => void;
  cols: number; rows: number;
  offsetX: number; offsetY: number; marginX: number; marginY: number;
  offsets: Nudge[];
  onOffsetsChange: (next: Nudge[]) => void;
  selected: number | null;
  onSelect: (idx: number | null) => void;
}) {
  const { t } = useTranslation('spriteStudio');
  const imgRef = useRef<HTMLImageElement | null>(null);
  const drag = useRef<{ idx: number; px: number; py: number; dx: number; dy: number } | null>(null);

  const layout = computeResliceLayout({
    width: nat?.w ?? 1,
    height: nat?.h ?? 1,
    cols,
    rows,
    offsetX,
    offsetY,
    marginX,
    marginY,
  });
  const { width: w, height: h, cellW, cellH } = layout;

  const setOne = (idx: number, n: Nudge) => {
    const next = offsets.slice();
    while (next.length < cols * rows) next.push({ ...ZERO });
    next[idx] = n;
    onOffsetsChange(next);
  };

  const onDown = (idx: number) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    onSelect(idx);
    const cur = offsets[idx] ?? ZERO;
    drag.current = { idx, px: e.clientX, py: e.clientY, dx: cur.dx, dy: cur.dy };
  };
  const onMove = (idx: number) => (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.idx !== idx || !imgRef.current || !nat) return;
    const rw = imgRef.current.clientWidth || 1;
    const rh = imgRef.current.clientHeight || 1;
    const ndx = d.dx + ((e.clientX - d.px) * w) / rw;
    const ndy = d.dy + ((e.clientY - d.py) * h) / rh;
    setOne(idx, clampResliceNudge(layout, idx, { dx: ndx, dy: ndy }));
  };
  const onUp = (e: React.PointerEvent) => {
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };
  const onKeyDown = (idx: number) => (e: React.KeyboardEvent) => {
    const cur = offsets[idx] ?? ZERO;
    const step = e.shiftKey ? 10 : 1;
    let next: Nudge | null = null;
    if (e.key === 'ArrowLeft') next = { dx: cur.dx - step, dy: cur.dy };
    else if (e.key === 'ArrowRight') next = { dx: cur.dx + step, dy: cur.dy };
    else if (e.key === 'ArrowUp') next = { dx: cur.dx, dy: cur.dy - step };
    else if (e.key === 'ArrowDown') next = { dx: cur.dx, dy: cur.dy + step };
    else if (e.key === 'Enter' || e.key === ' ') onSelect(idx);
    else if (e.key === 'Backspace' || e.key === 'Delete') next = { ...ZERO };
    else return;
    e.preventDefault();
    e.stopPropagation();
    onSelect(idx);
    if (next) setOne(idx, clampResliceNudge(layout, idx, next));
  };

  return (
    <div className="flex justify-center overflow-hidden rounded border bg-muted/30" style={{ maxHeight: 260 }}>
      <div className="relative select-none">
        <img
          ref={imgRef}
          src={src}
          alt={alt}
          className="block max-h-[260px] w-auto max-w-full object-contain"
          style={{ imageRendering: 'pixelated' }}
          draggable={false}
          onLoad={(e) => onNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
        />
        {/* Click empty space (offset/margin gutters) to deselect. */}
        <div className="absolute inset-0" onPointerDown={() => onSelect(null)}>
          {Array.from({ length: cols * rows }).map((_, idx) => {
                const nud = offsets[idx] ?? ZERO;
                const rect = resliceCellRect(layout, idx, nud);
                const isSel = selected === idx;
                const moved = nud.dx !== 0 || nud.dy !== 0;
                return (
                  <button
                    key={idx}
                    type="button"
                    title={t('frames.resliceCellHint')}
                    aria-label={t('frames.resliceCellHint')}
                    onPointerDown={onDown(idx)}
                    onPointerMove={onMove(idx)}
                    onPointerUp={onUp}
                    onKeyDown={onKeyDown(idx)}
                    onDoubleClick={(e) => { e.stopPropagation(); setOne(idx, { ...ZERO }); }}
                    className={cn(
                      'absolute box-border cursor-move touch-none border bg-transparent p-0 text-left transition-colors focus:outline-none focus:ring-1 focus:ring-primary',
                      isSel
                        ? 'z-10 border-primary bg-primary/10'
                        : moved
                          ? 'border-amber-400/80 bg-amber-400/5 hover:border-amber-400'
                          : 'border-primary/40 hover:border-primary/80',
                    )}
                    style={{
                      left: `${(rect.x / w) * 100}%`, top: `${(rect.y / h) * 100}%`,
                      width: `${(cellW / w) * 100}%`, height: `${(cellH / h) * 100}%`,
                    }}
                  >
                    <span className="pointer-events-none absolute left-0.5 top-0.5 rounded bg-background/70 px-1 text-[9px] font-medium tabular-nums text-foreground">
                      {idx + 1}
                    </span>
                  </button>
                );

          })}
        </div>
      </div>
    </div>
  );
}
