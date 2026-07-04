/**
 * Import an existing sprite sheet: pick a PNG/JPEG + a cols×rows grid (with a
 * live slicing overlay), POST /import-sheet to cut it into 'imported' versions,
 * then create an animation whose frames are those slices (row-major order).
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ImageUp } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../../../components/ui/dialog.js';
import { Button } from '../../../../components/ui/button.js';
import { Input } from '../../../../components/ui/input.js';
import { toast } from '../../../../components/ui/prompt-dialog.js';
import { createAnimation, saveFrames } from '../api-anim.js';
import { importSheet } from '../api-anim-bulk.js';

export function ImportSheetDialog({
  open,
  onOpenChange,
  projectId,
  assetId,
  onImported,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projectId: number;
  assetId: number;
  onImported: (animationId: number) => void;
}) {
  const { t } = useTranslation('spriteStudio');
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('imported');
  const [cols, setCols] = useState(4);
  const [rows, setRows] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const previewUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);
  useEffect(() => {
    if (!open) { setFile(null); setName('imported'); setCols(4); setRows(1); setError(null); }
  }, [open]);

  const valid = file != null && cols > 0 && rows > 0 && name.trim() !== '';

  const run = async () => {
    if (!file || !valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { versionIds } = await importSheet(projectId, assetId, file, cols, rows);
      if (versionIds.length === 0) throw new Error(t('frames.importEmpty'));
      const animation = await createAnimation(projectId, assetId, { name: name.trim(), frames: Math.min(12, versionIds.length) });
      await saveFrames(animation.id, versionIds.map((versionId, i) => ({ frameIndex: i, versionId, durationMs: null })));
      toast.success(t('frames.importDone', { n: versionIds.length }));
      onImported(animation.id);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ImageUp className="h-4 w-4" /> {t('frames.importTitle')}
          </DialogTitle>
        </DialogHeader>
        <Input
          type="file"
          accept="image/png,image/jpeg"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="h-8 text-xs"
        />
        {previewUrl && (
          <div className="relative overflow-hidden rounded border bg-muted/30" style={{ maxHeight: 220 }}>
            <img src={previewUrl} alt={t('frames.importTitle')} className="max-h-[220px] w-full object-contain" style={{ imageRendering: 'pixelated' }} />
            <div className="pointer-events-none absolute inset-0">
              {Array.from({ length: cols - 1 }).map((_, i) => (
                <span key={`c${i}`} className="absolute top-0 h-full w-px bg-primary/50" style={{ left: `${((i + 1) / cols) * 100}%` }} />
              ))}
              {Array.from({ length: rows - 1 }).map((_, i) => (
                <span key={`r${i}`} className="absolute left-0 w-full border-t border-primary/50" style={{ top: `${((i + 1) / rows) * 100}%` }} />
              ))}
            </div>
          </div>
        )}
        <div className="grid grid-cols-3 gap-2">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">{t('frames.importName')}</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} className="h-8 text-sm" />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">{t('frames.importCols')}</span>
            <Input type="number" min={1} max={16} value={cols} onChange={(e) => setCols(Math.max(1, Math.min(16, Number(e.target.value) || 1)))} className="h-8 text-sm" />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">{t('frames.importRows')}</span>
            <Input type="number" min={1} max={16} value={rows} onChange={(e) => setRows(Math.max(1, Math.min(16, Number(e.target.value) || 1)))} className="h-8 text-sm" />
          </label>
        </div>
        {error && <div className="rounded border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-400">{error}</div>}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>{t('newAsset.cancel')}</Button>
          <Button size="sm" disabled={busy || !valid} onClick={() => void run()}>
            {busy ? t('frames.importing') : t('frames.import')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
