/**
 * Top contextual options bar for the active tool. Controls are bound to
 * editor-store.toolOptions and fg/bg colors; each change writes the store (so
 * React reflects it) AND pushes straight into the engine (setToolOptions /
 * setColors) so tools read the new value on the next gesture without a render.
 * The recent-colors row only writes the store — the EditModeView store→engine
 * bridge forwards it to painting.
 */
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeftRight } from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import { RangeInput } from '../../../components/ui/range-input.js';
import type { EditorEngine } from '../engine/EditorEngine.js';
import { useSpriteEditorStore } from '../store/editor-store.js';
import type { ToolOptions } from '../tools/tool-types.js';

export function ToolOptionsBar({ engine }: { engine: EditorEngine }) {
  const { t } = useTranslation('spriteStudio');
  const activeTool = useSpriteEditorStore((s) => s.activeTool);
  const options = useSpriteEditorStore((s) => s.toolOptions);
  const setToolOptions = useSpriteEditorStore((s) => s.setToolOptions);
  const fgColor = useSpriteEditorStore((s) => s.fgColor);
  const bgColor = useSpriteEditorStore((s) => s.bgColor);
  const recentColors = useSpriteEditorStore((s) => s.recentColors);
  const setFgColor = useSpriteEditorStore((s) => s.setFgColor);
  const setBgColor = useSpriteEditorStore((s) => s.setBgColor);
  const swapColors = useSpriteEditorStore((s) => s.swapColors);
  const hasSelection = useSpriteEditorStore((s) => s.hasSelection);

  const patch = (p: Partial<ToolOptions>) => {
    setToolOptions(p);
    engine.setToolOptions(p);
  };

  const isBrush = activeTool === 'brush' || activeTool === 'eraser';
  const isMagicEraser = activeTool === 'magic-eraser';
  const isWand = activeTool === 'select-wand' || activeTool === 'fill' || isMagicEraser;
  const isShape = activeTool === 'line' || activeTool === 'shape-rect' || activeTool === 'shape-ellipse';
  const selectionCommand = (label: string, command: () => void) => {
    const before = engine.selection.snapshot(); command(); const after = engine.selection.snapshot();
    engine.history.pushSelection(before, after, label); engine.invalidate(); engine.emitSummary();
  };

  return (
    <div
      className={cn(
        'flex min-h-8 max-h-20 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 overflow-y-auto',
        'border-b bg-muted/10 px-2 py-1 text-[11px] [scrollbar-gutter:stable]',
      )}
    >
      {(isBrush || isShape) && (
        <Range
          label={t('options.size')} min={1} max={32} value={options.size}
          onChange={(v) => patch({ size: v })} suffix="px"
        />
      )}
      {isBrush && (
        <>
          <Range
            label={t('options.softness')} min={0} max={100} value={options.softness}
            onChange={(v) => patch({ softness: v })} suffix="%"
          />
          <Range
            label={t('options.opacity')} min={1} max={100} value={options.opacity ?? 100}
            onChange={(v) => patch({ opacity: v })} suffix="%"
          />
          <Toggle
            label={t('options.round')} active={options.shape === 'round'}
            onClick={() => patch({ shape: options.shape === 'round' ? 'square' : 'round' })}
          />
          <Toggle
            label={t('options.mirrorX')} active={options.mirrorX === true}
            onClick={() => patch({ mirrorX: options.mirrorX !== true })}
          />
          <Toggle
            label={t('options.dither')} active={options.dither === true}
            onClick={() => patch({ dither: options.dither !== true })}
          />
        </>
      )}
      {isShape && activeTool !== 'line' && (
        <Toggle
          label={t('options.fill')} active={options.shapeFill === true}
          onClick={() => patch({ shapeFill: options.shapeFill !== true })}
        />
      )}
      {isWand && (
        <>
          <Range
            label={t('options.tolerance')} min={0} max={255} value={options.tolerance}
            onChange={(v) => patch({ tolerance: v })}
          />
          <Toggle
            label={t('options.contiguous')} active={options.contiguous}
            onClick={() => patch({ contiguous: !options.contiguous })}
          />
          {isMagicEraser && (
            <Range
              label={t('options.edgeCleanup')} min={0} max={3} value={options.edgeCleanup ?? 0}
              onChange={(v) => patch({ edgeCleanup: v })} suffix="px"
            />
          )}
          {activeTool === 'select-wand' && (
            <>
              <SelectField label={t('options.sampleSource')} value={options.sampleSource ?? 'active'}
                onChange={(value) => patch({ sampleSource: value as ToolOptions['sampleSource'] })}
                options={[['active', t('options.activeLayer')], ['merged', t('options.mergedVisible')]]} />
              <SelectField label={t('options.matchMode')} value={options.matchMode ?? 'color'}
                onChange={(value) => patch({ matchMode: value as ToolOptions['matchMode'] })}
                options={[['color', t('options.color')], ['alpha', t('options.alpha')]]} />
              {options.matchMode !== 'alpha' && <SelectField label={t('options.colorMetric')} value={options.colorMetric ?? 'channel'}
                onChange={(value) => patch({ colorMetric: value as ToolOptions['colorMetric'] })}
                options={[['perceptual', t('options.perceptual')], ['channel', t('options.channel')]]} />}
            </>
          )}
        </>
      )}
      {!isBrush && !isWand && !isShape && (
        <span className="text-muted-foreground">{t('options.none')}</span>
      )}

      {hasSelection && (
        <div className="flex min-w-0 flex-wrap items-center gap-0.5 border-l pl-2">
          <Toggle label={t('selection.invert')} active={false} onClick={() => selectionCommand('Invert selection', () => engine.selection.invert())} />
          <Toggle label={t('selection.grow')} active={false} onClick={() => selectionCommand('Grow selection', () => engine.selection.resizeBy(1))} />
          <Toggle label={t('selection.shrink')} active={false} onClick={() => selectionCommand('Shrink selection', () => engine.selection.resizeBy(-1))} />
          <Toggle label={t('selection.fillHoles')} active={false} onClick={() => selectionCommand('Fill selection holes', () => engine.selection.fillHoles())} />
          <Toggle label={t('selection.removeIslands')} active={false} onClick={() => selectionCommand('Remove small islands', () => engine.selection.removeSmallIslands(4))} />
        </div>
      )}

      <div className="ml-auto flex shrink-0 items-center gap-1">
        <Swatch label={t('options.foreground')} color={fgColor} onChange={(v) => { setFgColor(v); engine.setColors({ fg: v }); }} />
        <button
          type="button" onClick={swapColors} title={t('options.swapColors')} aria-label={t('options.swapColors')}
          className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ArrowLeftRight className="h-3 w-3" />
        </button>
        <Swatch label={t('options.background')} color={bgColor} onChange={(v) => { setBgColor(v); engine.setColors({ bg: v }); }} />
        {recentColors.length > 0 && (
          <>
            <span className="mx-0.5 h-4 w-px bg-border" />
            <RecentSwatches colors={recentColors} onPick={setFgColor} />
          </>
        )}
      </div>
    </div>
  );
}

function SelectField({
  label, value, options, onChange,
}: {
  label: string; value: string; options: Array<[string, string]>; onChange: (value: string) => void;
}) {
  return (
    <label className="flex min-w-0 shrink-0 items-center gap-1 text-muted-foreground">
      <span className="shrink-0">{label}</span>
      <select className="h-6 max-w-40 rounded border bg-background px-1 text-[11px]" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([key, text]) => <option key={key} value={key}>{text}</option>)}
      </select>
    </label>
  );
}

/** MRU foreground picks. Click writes the store only — the EditModeView
 *  store→engine bridge pushes it to the engine. Memoized: the row skips the
 *  frequent re-renders of the bar (tool/option churn) when colors are stable. */
const RecentSwatches = memo(function RecentSwatches({
  colors, onPick,
}: {
  colors: string[]; onPick: (hex: string) => void;
}) {
  return (
    <div className="flex items-center gap-0.5">
      {colors.map((hex) => (
        <button
          key={hex} type="button" onClick={() => onPick(hex)} title={hex}
          className="h-4 w-4 rounded-sm border border-border transition-transform hover:scale-110"
          style={{ backgroundColor: hex }}
        />
      ))}
    </div>
  );
});

function Range({
  label, min, max, value, onChange, suffix,
}: {
  label: string; min: number; max: number; value: number;
  onChange: (v: number) => void; suffix?: string;
}) {
  return (
    <RangeInput
      label={label} min={min} max={max} value={value} onChange={onChange} suffix={suffix}
      className="shrink-0 text-muted-foreground"
      sliderClassName="w-16 min-[1500px]:w-24"
    />
  );
}

function Toggle({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button" onClick={onClick} aria-pressed={active}
      className={cn(
        'rounded px-1.5 py-0.5 transition-colors',
        active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {label}
    </button>
  );
}

function Swatch({ label, color, onChange }: { label: string; color: string; onChange: (hex: string) => void }) {
  return (
    <label className="relative h-5 w-5 cursor-pointer rounded border border-border" title={label} style={{ backgroundColor: color }}>
      <input
        type="color" value={color} onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
      />
    </label>
  );
}
