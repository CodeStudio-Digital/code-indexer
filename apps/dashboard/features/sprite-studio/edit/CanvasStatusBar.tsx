/**
 * Bottom status strip of the editor: a Photoshop-style zoom cluster (log-scale
 * slider over MIN..MAX zoom with ladder tick marks + a typeable % readout,
 * both driving engine.setZoomCentered), cursor image coords + color under the
 * cursor, an active-selection hint (so nobody wonders why painting outside
 * the marquee does nothing — Esc clears), the pixel-grid toggle, document size
 * and a live undo-history memory readout. Every field comes from an individual
 * selector (zoom%/mem/selection from the zustand editor-store; cursor from the
 * cursor-readout external store) so the strip repaints on its own without
 * touching the canvas host. Grid state lives in EditModeView (it owns the
 * engine + persistence) and arrives via props, as does the optional engine
 * (absent → the cluster degrades to a plain % readout).
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Grid3x3 } from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import type { EditorEngine } from '../engine/EditorEngine.js';
import { MAX_ZOOM, MIN_ZOOM, ZOOM_LADDER } from '../engine/viewport.js';
import { useSpriteEditorStore } from '../store/editor-store.js';
import { useCursorReadout } from './cursor-readout.js';

/** Bytes → compact MB/KB string for the history budget readout. */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

// Log-scale mapping between slider units (0..SLIDER_MAX) and zoom factor, so
// the travel from 6% to 100% gets as much room as 100% to 3200% (à la PS).
const SLIDER_MAX = 1000;
const LOG_MIN = Math.log(MIN_ZOOM);
const LOG_RANGE = Math.log(MAX_ZOOM) - LOG_MIN;
const zoomToSlider = (zoom: number): number =>
  Math.round(((Math.log(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))) - LOG_MIN) / LOG_RANGE) * SLIDER_MAX);
const sliderToZoom = (v: number): number => Math.exp(LOG_MIN + (v / SLIDER_MAX) * LOG_RANGE);

/** Slider + typeable % input, both centered-zooming through the engine. */
function ZoomControls({ engine }: { engine: EditorEngine }) {
  const { t } = useTranslation('spriteStudio');
  const zoomPct = useSpriteEditorStore((s) => s.zoomPct);
  const [slider, setSlider] = useState(() => zoomToSlider(zoomPct / 100));
  const [draft, setDraft] = useState<string | null>(null);
  const dragging = useRef(false);

  // Follow zoom changes from elsewhere (wheel, fit, 1:1) unless mid-drag.
  useEffect(() => {
    if (!dragging.current) setSlider(zoomToSlider(zoomPct / 100));
  }, [zoomPct]);

  const commitDraft = () => {
    const n = Number(draft);
    if (draft != null && Number.isFinite(n) && n > 0) engine.setZoomCentered(n / 100);
    setDraft(null);
  };

  return (
    <span className="flex items-center gap-1.5" title={t('statusBar.zoom')}>
      <input
        type="range" min={0} max={SLIDER_MAX} value={slider} list="sprite-zoom-ticks"
        aria-label={t('statusBar.zoomSlider')}
        onPointerDown={() => { dragging.current = true; }}
        onPointerUp={() => { dragging.current = false; }}
        onChange={(e) => {
          const v = Number(e.target.value);
          setSlider(v);
          engine.setZoomCentered(sliderToZoom(v));
        }}
        className="h-1 w-24 cursor-pointer accent-primary"
      />
      <datalist id="sprite-zoom-ticks">
        {ZOOM_LADDER.map((z) => <option key={z} value={zoomToSlider(z)} />)}
      </datalist>
      <input
        type="text" inputMode="numeric" value={draft ?? String(zoomPct)}
        aria-label={t('statusBar.zoomInput')}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitDraft}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commitDraft(); }
          else if (e.key === 'Escape') setDraft(null);
        }}
        className="h-4 w-9 rounded border border-border bg-transparent px-1 text-right tabular-nums text-foreground outline-none focus:border-primary"
      />
      <span>%</span>
    </span>
  );
}

export function CanvasStatusBar({
  gridOn,
  onToggleGrid,
  engine,
}: {
  gridOn: boolean;
  onToggleGrid: () => void;
  /** Optional — enables the zoom slider/input (plain % readout without it). */
  engine?: EditorEngine | null;
}) {
  const { t } = useTranslation('spriteStudio');
  const zoomPct = useSpriteEditorStore((s) => s.zoomPct);
  const memBytes = useSpriteEditorStore((s) => s.memBytes);
  const hasSelection = useSpriteEditorStore((s) => s.hasSelection);
  // From the engine summary — stays fresh across resize ops and undo/redo
  // (render-time props from engine.doc would go stale mid-history).
  const docW = useSpriteEditorStore((s) => s.docW);
  const docH = useSpriteEditorStore((s) => s.docH);
  const { x, y, hex } = useCursorReadout();

  return (
    <div className="flex h-6 shrink-0 items-center gap-3 border-t bg-muted/20 px-2 text-[10px] text-muted-foreground">
      {engine ? (
        <ZoomControls engine={engine} />
      ) : (
        <span className="tabular-nums" title={t('statusBar.zoom')}>{`${zoomPct}%`}</span>
      )}
      <span className="h-3 w-px bg-border" />
      <span className="tabular-nums" title={t('statusBar.cursor')}>
        {x != null && y != null ? `${x}, ${y}` : '—, —'}
      </span>
      <span className="flex items-center gap-1" title={t('statusBar.color')}>
        <span
          className="inline-block h-3 w-3 rounded-sm border border-border"
          style={{ backgroundColor: hex ?? 'transparent' }}
        />
        <span className="font-mono">{hex ?? '—'}</span>
      </span>
      {hasSelection && (
        <span className="rounded bg-primary/15 px-1.5 py-px text-primary">
          {t('statusBar.selectionHint')}
        </span>
      )}
      <span className="ml-auto tabular-nums" title={t('statusBar.size')}>{`${docW} × ${docH}`}</span>
      <span className="h-3 w-px bg-border" />
      <span className="tabular-nums" title={t('statusBar.memory')}>{formatBytes(memBytes)}</span>
      <span className="h-3 w-px bg-border" />
      <button
        type="button" onClick={onToggleGrid} aria-pressed={gridOn}
        title={t('options.gridToggle')} aria-label={t('options.gridToggle')}
        className={cn(
          'flex h-4 w-4 items-center justify-center rounded hover:bg-muted',
          gridOn ? 'text-foreground' : 'text-muted-foreground/50 hover:text-foreground',
        )}
      >
        <Grid3x3 className="h-3 w-3" />
      </button>
    </div>
  );
}
