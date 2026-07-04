/**
 * Inspector edit-mode card: the active image's extracted palette. Runs the
 * deterministic median-cut extractor over the engine's active ImageData —
 * automatically on mount and whenever the engine changes (the refresh button
 * stays for re-extracting after edits) — renders the swatches, and sets the
 * foreground color when one is clicked. A local "lock palette" toggle freezes
 * the current swatches (surfaced to the parent via onPaletteChange) so
 * AdjustmentsCard's quantize maps to it instead of re-extracting.
 *
 * Props the parent must pass:
 *   engine            EditorEngine | null            — active asset's engine
 *   onPaletteChange?  (palette: string[] | null) => void
 *                                                    — fires with the locked
 *                       palette (or null when unlocked) for quantize wiring
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Lock, Palette, RefreshCw, Unlock } from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import type { EditorEngine } from '../engine/EditorEngine.js';
import { extractPalette } from '../algorithms/palette-extract.js';
import { spriteEditorActions } from '../store/editor-store.js';

const MAX_COLORS = 24;

export function PaletteCard({
  engine,
  onPaletteChange,
}: {
  engine: EditorEngine | null;
  onPaletteChange?: (palette: string[] | null) => void;
}) {
  const { t } = useTranslation('spriteStudio');
  const [swatches, setSwatches] = useState<string[]>([]);
  const [locked, setLocked] = useState(false);

  const extract = useCallback(() => {
    if (!engine || locked) return;
    const img = engine.getActiveImageData();
    if (!img) { setSwatches([]); return; }
    setSwatches(extractPalette({ data: img.data, width: img.width, height: img.height }, { maxColors: MAX_COLORS }));
  }, [engine, locked]);

  // Auto-extract on mount and when the engine (asset) changes — the palette
  // should just be there, not hide behind the refresh button. Locked skips
  // inside extract(), so a frozen palette is never overwritten.
  useEffect(() => { extract(); }, [extract]);

  const toggleLock = () => {
    const next = !locked;
    setLocked(next);
    onPaletteChange?.(next ? swatches : null);
  };

  const pick = (hex: string) => spriteEditorActions().setFgColor(hex);

  return (
    <div className="space-y-2 rounded border p-2">
      <div className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        <Palette className="h-3 w-3" /> {t('palette.title')}
        <button
          type="button" onClick={extract} disabled={!engine || locked}
          title={t('palette.refresh')} aria-label={t('palette.refresh')}
          className="ml-auto flex h-5 w-5 items-center justify-center rounded hover:bg-muted hover:text-foreground disabled:opacity-40"
        >
          <RefreshCw className="h-3 w-3" />
        </button>
        <button
          type="button" onClick={toggleLock} disabled={swatches.length === 0}
          title={locked ? t('palette.unlock') : t('palette.lock')} aria-label={locked ? t('palette.unlock') : t('palette.lock')}
          className={cn(
            'flex h-5 w-5 items-center justify-center rounded disabled:opacity-40',
            locked ? 'text-primary' : 'hover:bg-muted hover:text-foreground',
          )}
        >
          {locked ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
        </button>
      </div>

      {swatches.length === 0 ? (
        <div className="py-1 text-[11px] text-muted-foreground">{t('palette.empty')}</div>
      ) : (
        <div className="flex flex-wrap gap-1">
          {swatches.map((hex, i) => (
            <button
              key={`${hex}-${i}`}
              type="button"
              onClick={() => pick(hex)}
              title={hex}
              aria-label={hex}
              className="h-5 w-5 rounded border border-border transition-transform hover:scale-110"
              style={{ backgroundColor: hex }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
