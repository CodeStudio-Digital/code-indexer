/**
 * Inspector edit-mode card: local, deterministic image operations. Each button
 * runs a pure `algorithms/*` function against the engine's ACTIVE ImageData and
 * commits the result back through the engine's public surface (see apply-op.ts).
 *
 * Props the parent (InspectorPanel / SpriteStudioView orchestrator) must pass:
 *   engine    EditorEngine | null  — the active asset's engine (null → card is idle)
 *   palette?  string[]             — locked palette from PaletteCard for quantize;
 *                                    when absent the card auto-extracts one
 *
 * All ops are undoable: same-size ops as whole-doc snapshot commands, and the
 * dimension-changing upscale / auto-crop through engine.applyResizedActive
 * (snapshots carry doc dims). Resizes are refused on multi-layer documents —
 * a toast tells the user to flatten first (LayerList has the button).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Crop, Eraser, FlipHorizontal2, FlipVertical2, Maximize2, Palette, PenLine, RotateCw, SlidersHorizontal,
} from 'lucide-react';
import { toast } from '../../../components/ui/prompt-dialog.js';
import { Button } from '../../../components/ui/button.js';
import { RangeInput } from '../../../components/ui/range-input.js';
import type { EditorEngine } from '../engine/EditorEngine.js';
import { chromaKeyRemove, removeBackground } from '../algorithms/bg-remove.js';
import { addOutline } from '../algorithms/outline.js';
import { mapToPalette, type DitherMode } from '../algorithms/quantize.js';
import { extractPalette } from '../algorithms/palette-extract.js';
import { cropToAlphaBBox } from '../algorithms/auto-crop.js';
import { thresholdAlpha } from '../algorithms/alpha-cleanup.js';
import { nearestNeighborScale } from '../algorithms/scale.js';
import { flipHorizontal, flipVertical, rotate90 } from '../algorithms/transform.js';
import { applyRasterOp } from './apply-op.js';
import { InspectorSection } from './InspectorSection.js';

const DITHERS: DitherMode[] = ['none', 'floyd-steinberg', 'bayer4', 'bayer8'];

export function AdjustmentsCard({ engine, palette }: { engine: EditorEngine | null; palette?: string[] }) {
  const { t } = useTranslation('spriteStudio');
  const [dither, setDither] = useState<DitherMode>('floyd-steinberg');
  const [bgTolerance, setBgTolerance] = useState(48);
  const [bgGlobal, setBgGlobal] = useState(true);
  const [outlineColor, setOutlineColor] = useState('#000000');
  const [outlineThickness, setOutlineThickness] = useState(1);

  const run = (label: string, op: Parameters<typeof applyRasterOp>[1]) => {
    if (!engine) return;
    const res = applyRasterOp(engine, op, label);
    if (res.refused === 'multi-layer') {
      toast.warning(t('adjust.title'), { description: t('edit.flattenFirst') });
      return;
    }
    if (!res.ok) { toast.error(t('adjust.title'), { description: t('adjust.noImage') }); return; }
    if (res.historyCleared) toast.warning(t('adjust.title'), { description: t('adjust.historyCleared') });
  };

  const disabled = !engine;

  return (
    <InspectorSection id="adjust" icon={SlidersHorizontal} title={t('adjust.title')}>
      {/* Quantize */}
      <div className="flex items-center gap-1">
        <select
          className="h-6 flex-1 rounded border bg-background px-1 text-[11px]"
          value={dither} onChange={(e) => setDither(e.target.value as DitherMode)}
          aria-label={t('adjust.ditherLabel')}
        >
          {DITHERS.map((d) => <option key={d} value={d}>{t(`adjust.dither.${d}`)}</option>)}
        </select>
        <OpButton
          icon={Palette} label={t('adjust.quantize')} disabled={disabled}
          onClick={() => run('Quantize', (r) => {
            const pal = palette && palette.length > 0 ? palette : extractPalette(r, { maxColors: 16 });
            return mapToPalette(r, pal, { dither });
          })}
        />
      </div>

      {/* Background removal — global chroma sweep (default: clears interior
          islands + JPEG noise) or the conservative border flood. */}
      <Range label={t('adjust.bgTolerance')} min={0} max={128} value={bgTolerance} onChange={setBgTolerance} />
      <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <input
          type="checkbox" checked={bgGlobal} onChange={(e) => setBgGlobal(e.target.checked)}
          className="h-3 w-3 accent-primary"
        />
        {t('adjust.bgGlobal')}
      </label>
      <OpButton
        icon={Eraser} label={t('adjust.bgRemove')} disabled={disabled} full
        onClick={() => run('Remove background', (r) =>
          bgGlobal
            ? chromaKeyRemove(r, { tolerance: bgTolerance })
            : removeBackground(r, { tolerance: bgTolerance }),
        )}
      />

      {/* Outline */}
      <div className="flex items-center gap-1">
        <label className="h-6 w-6 shrink-0 cursor-pointer rounded border border-border" title={t('adjust.outlineColor')} style={{ backgroundColor: outlineColor }}>
          <input type="color" value={outlineColor} onChange={(e) => setOutlineColor(e.target.value)} aria-label={t('adjust.outlineColor')} className="h-full w-full cursor-pointer opacity-0" />
        </label>
        <select
          className="h-6 w-14 rounded border bg-background px-1 text-[11px]"
          value={outlineThickness} onChange={(e) => setOutlineThickness(Number(e.target.value))}
          aria-label={t('adjust.outlineThickness')}
        >
          {[1, 2, 3].map((n) => <option key={n} value={n}>{`${n}px`}</option>)}
        </select>
        <OpButton
          icon={PenLine} label={t('adjust.outline')} disabled={disabled}
          onClick={() => run('Outline', (r) => addOutline(r, { colorHex: outlineColor, thickness: outlineThickness }))}
        />
      </div>

      {/* One-shot ops */}
      <div className="grid grid-cols-3 gap-1">
        <OpButton icon={SlidersHorizontal} label={t('adjust.alphaClean')} disabled={disabled}
          onClick={() => run('Alpha cleanup', (r) => thresholdAlpha(r))} />
        <OpButton icon={Crop} label={t('adjust.autoCrop')} disabled={disabled}
          onClick={() => run('Auto-crop', (r) => cropToAlphaBBox(r))} />
        <OpButton icon={Maximize2} label={t('adjust.upscale')} disabled={disabled}
          onClick={() => run('Upscale 2×', (r) => nearestNeighborScale(r, 2))} />
      </div>

      {/* Transforms — flips are same-size (snapshot-undo); rotate90 on a
          non-square image rides the applyResizedActive path, also undoable. */}
      <div className="grid grid-cols-3 gap-1">
        <OpButton icon={FlipHorizontal2} label={t('adjust.flipH')} disabled={disabled}
          onClick={() => run('Flip horizontal', flipHorizontal)} />
        <OpButton icon={FlipVertical2} label={t('adjust.flipV')} disabled={disabled}
          onClick={() => run('Flip vertical', flipVertical)} />
        <OpButton icon={RotateCw} label={t('adjust.rotate90')} disabled={disabled}
          onClick={() => run('Rotate 90°', rotate90)} />
      </div>
    </InspectorSection>
  );
}

function OpButton({
  icon: Icon, label, onClick, disabled, full,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string; onClick: () => void; disabled?: boolean; full?: boolean;
}) {
  return (
    <Button
      size="sm" variant="outline" disabled={disabled} onClick={onClick} title={label}
      className={full ? 'h-6 w-full justify-start gap-1 text-[11px]' : 'h-6 gap-1 px-1.5 text-[11px]'}
    >
      <Icon className="h-3 w-3 shrink-0" />
      <span className="truncate">{label}</span>
    </Button>
  );
}

function Range({ label, min, max, value, onChange }: { label: string; min: number; max: number; value: number; onChange: (v: number) => void }) {
  return (
    <RangeInput
      label={label} min={min} max={max} value={value} onChange={onChange}
      className="text-[11px] text-muted-foreground" labelClassName="w-16" sliderClassName="flex-1"
    />
  );
}
