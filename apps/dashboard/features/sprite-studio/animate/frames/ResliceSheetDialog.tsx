/**
 * Re-slice a batch's ORIGINAL sheet with a custom grid. Shows the kept sheet
 * with a live overlay (usable region + cell lines) driven by cols/rows and
 * offset/margin in source pixels, so the user can recover clean frames when the
 * model's auto-grid was off-center or padded. On apply → new frame versions →
 * set as the open animation's timeline.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RotateCcw, Scissors } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../../../components/ui/dialog.js';
import { Button } from '../../../../components/ui/button.js';
import { Input } from '../../../../components/ui/input.js';
import { toast } from '../../../../components/ui/prompt-dialog.js';
import { useAnimateSession } from '../animate-session-store.js';
import { jobSheetUrl, resliceSheet } from '../api-anim-bulk.js';
import { ResliceOverlay } from './ResliceOverlay.js';
import type { Nudge } from './reslice-geometry.js';

export function ResliceSheetDialog({
  open,
  onOpenChange,
  projectId,
  assetId,
  jobId,
  defaultGrid,
  refresh,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projectId: number;
  assetId: string;
  jobId: string;
  defaultGrid: { cols: number; rows: number };
  refresh: () => void;
}) {
  const { t } = useTranslation('spriteStudio');
  const [cols, setCols] = useState(defaultGrid.cols);
  const [rows, setRows] = useState(defaultGrid.rows);
  const [offsetX, setOffsetX] = useState(0);
  const [offsetY, setOffsetY] = useState(0);
  const [marginX, setMarginX] = useState(0);
  const [marginY, setMarginY] = useState(0);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per-cell manual nudges (source px, row-major) + the selected cell.
  const [offsets, setOffsets] = useState<Nudge[]>([]);
  const [selected, setSelected] = useState<number | null>(null);

  const clearOffsets = () => { setOffsets([]); setSelected(null); };

  useEffect(() => {
    if (!open) return;
    setCols(defaultGrid.cols); setRows(defaultGrid.rows);
    setOffsetX(0); setOffsetY(0); setMarginX(0); setMarginY(0); setError(null);
    setOffsets([]); setSelected(null);
  }, [open, defaultGrid.cols, defaultGrid.rows]);

  const w = nat?.w ?? 1;
  const h = nat?.h ?? 1;
  const hasOffsets = offsets.some((o) => o && (o.dx !== 0 || o.dy !== 0));

  const num = (setter: (n: number) => void, max: number) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setter(Math.max(0, Math.min(max, Number(e.target.value) || 0)));
    clearOffsets();
  };
  // Changing the cell COUNT invalidates the per-cell nudges → reset them.
  const numGrid = (setter: (n: number) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setter(Math.max(1, Math.min(16, Number(e.target.value) || 1)));
    clearOffsets();
  };

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const packed = hasOffsets
        ? Array.from({ length: cols * rows }, (_, i) => ({
            dx: Math.round(offsets[i]?.dx ?? 0), dy: Math.round(offsets[i]?.dy ?? 0),
          }))
        : undefined;
      const { versionIds } = await resliceSheet(projectId, assetId, jobId, {
        cols, rows, offsetX, offsetY, marginX, marginY, offsets: packed,
      });
      if (versionIds.length === 0) throw new Error(t('frames.importEmpty'));
      const setTimeline = useAnimateSession.getState().setTimeline;
      if (!setTimeline) { toast.error(t('frames.needAnimation')); return; }
      setTimeline(versionIds);
      refresh();
      toast.success(t('frames.reslicedDone', { n: versionIds.length }));
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Scissors className="h-4 w-4" /> {t('frames.resliceTitle')}
          </DialogTitle>
        </DialogHeader>
        <ResliceOverlay
          src={jobSheetUrl(projectId, jobId)}
          alt={t('frames.resliceTitle')}
          nat={nat}
          onNat={setNat}
          cols={cols} rows={rows}
          offsetX={offsetX} offsetY={offsetY} marginX={marginX} marginY={marginY}
          offsets={offsets}
          onOffsetsChange={setOffsets}
          selected={selected}
          onSelect={setSelected}
        />
        <p className="text-[10px] text-muted-foreground">{t('frames.resliceManualHint')}</p>
        <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
          <Field label={t('frames.importCols')} value={cols} onChange={numGrid(setCols)} min={1} />
          <Field label={t('frames.importRows')} value={rows} onChange={numGrid(setRows)} min={1} />
          <div />
          <Field label={t('frames.offsetX')} value={offsetX} onChange={num(setOffsetX, w)} min={0} />
          <Field label={t('frames.offsetY')} value={offsetY} onChange={num(setOffsetY, h)} min={0} />
          <div className="hidden sm:block" />
          <Field label={t('frames.marginX')} value={marginX} onChange={num(setMarginX, w)} min={0} />
          <Field label={t('frames.marginY')} value={marginY} onChange={num(setMarginY, h)} min={0} />
        </div>
        {error && <div className="rounded border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-400">{error}</div>}
        <div className="flex items-center justify-between gap-2 pt-1">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground">{nat ? `${nat.w}×${nat.h}px` : ''}</span>
            {hasOffsets && (
              <Button
                variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-[11px]"
                onClick={clearOffsets}
              >
                <RotateCcw className="h-3 w-3" /> {t('frames.resliceReset')}
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>{t('newAsset.cancel')}</Button>
            <Button size="sm" disabled={busy} onClick={() => void run()}>
              {busy ? t('frames.reslicing') : t('frames.resliceApply')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, value, onChange, min }: {
  label: string; value: number; onChange: (e: React.ChangeEvent<HTMLInputElement>) => void; min: number;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-muted-foreground">{label}</span>
      <Input type="number" min={min} value={value} onChange={onChange} className="h-7 text-sm" />
    </label>
  );
}
