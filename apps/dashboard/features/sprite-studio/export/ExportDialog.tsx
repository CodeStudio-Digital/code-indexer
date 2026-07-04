/**
 * ExportDialog — the export surface (opened from the toolbar). Choose a scope
 * (active asset / category / all approved), a format from the registry
 * (engine formats: Unity/Godot/Babylon/Defold/Cocos + Phaser + generic), its
 * options (padding/extrude/scale/includeAnimations), and a destination folder
 * (native Electron picker, with a text-field fallback). The backend writes
 * synchronously and returns the file list.
 *
 * Props (mounted by SpriteStudioView / the orchestrator):
 *   open:        boolean
 *   onClose:     () => void
 *   projectId:   number
 *   assets:      SpriteAsset[]          — full library (scoped locally)
 *   activeAsset: SpriteAsset | null
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, FolderOpen, Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../../components/ui/dialog.js';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { toast } from '../../../components/ui/prompt-dialog.js';
import * as api from '../api.js';
import { groupOfCategory, type SpriteAsset } from '../types.js';
import { EXPORT_FORMATS, defaultOptions, findFormat } from './export-formats.js';
import { SheetPreview } from './SheetPreview.js';

type Scope = 'asset' | 'category' | 'approved';
const selectCls = 'h-8 rounded border bg-background px-2 text-sm';

export function ExportDialog({
  open,
  onClose,
  projectId,
  assets,
  activeAsset,
}: {
  open: boolean;
  onClose: () => void;
  projectId: number;
  assets: SpriteAsset[];
  activeAsset: SpriteAsset | null;
}) {
  const { t } = useTranslation('spriteStudio');
  const [scope, setScope] = useState<Scope>(activeAsset ? 'asset' : 'approved');
  const [formatId, setFormatId] = useState(EXPORT_FORMATS[0].id);
  const [options, setOptions] = useState<Record<string, number | boolean>>(() => defaultOptions(EXPORT_FORMATS[0]));
  const [destDir, setDestDir] = useState('');
  const [busy, setBusy] = useState(false);

  const format = findFormat(formatId);
  const isElectron = typeof window !== 'undefined' && !!window.electronAPI?.openDirectory;

  useEffect(() => {
    if (!open) return;
    setScope(activeAsset ? 'asset' : 'approved');
  }, [open, activeAsset]);

  useEffect(() => { setOptions(defaultOptions(format)); }, [formatId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Assets in the chosen scope (drives the client-side preview).
  const scopedAssets = useMemo(() => {
    if (scope === 'asset') return activeAsset ? [activeAsset] : [];
    if (scope === 'category') {
      const g = activeAsset ? groupOfCategory(activeAsset.category) : null;
      return g ? assets.filter((a) => groupOfCategory(a.category) === g) : [];
    }
    return assets.filter((a) => a.status === 'approved');
  }, [scope, activeAsset, assets]);

  const pickDir = async () => {
    if (!isElectron) return;
    try {
      const dir = await window.electronAPI!.openDirectory!();
      if (dir) setDestDir(dir);
    } catch { /* cancelled */ }
  };

  const doExport = async () => {
    setBusy(true);
    try {
      const { includeAnimations, ...rest } = options;
      const { files } = await api.exportAssets(projectId, {
        scope,
        format: formatId,
        assetId: scope === 'asset' ? activeAsset?.id : undefined,
        category: scope === 'category' ? activeAsset?.category : undefined,
        includeAnimations: includeAnimations !== false,
        destDir: destDir || undefined,
        options: rest,
      });
      toast.success(t('export.done', { n: files.length }));
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(t('export.failed'), { description: msg });
    } finally {
      setBusy(false);
    }
  };

  const padding = typeof options.padding === 'number' ? options.padding : 0;
  const scale = typeof options.scale === 'number' ? options.scale : 1;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download className="h-4 w-4" /> {t('export.title')}
          </DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">{t('export.scope.label')}</span>
            <select className={selectCls} value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
              <option value="asset" disabled={!activeAsset}>{t('export.scope.asset')}</option>
              <option value="category" disabled={!activeAsset}>{t('export.scope.category')}</option>
              <option value="approved">{t('export.scope.approved')}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">{t('export.formatLabel')}</span>
            <select className={selectCls} value={formatId} onChange={(e) => setFormatId(e.target.value)}>
              {EXPORT_FORMATS.map((f) => <option key={f.id} value={f.id}>{t(`export.format.${f.labelKey}`)}</option>)}
            </select>
          </label>
        </div>

        {/* Format options (generic controls from the schema). */}
        <div className="flex flex-wrap gap-3">
          {format.options.map((opt) => (
            <label key={opt.key} className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">{t(`export.options.${opt.labelKey}`)}</span>
              {opt.type === 'boolean' ? (
                <input
                  type="checkbox"
                  checked={!!options[opt.key]}
                  onChange={(e) => setOptions((o) => ({ ...o, [opt.key]: e.target.checked }))}
                  className="h-4 w-4 accent-primary"
                />
              ) : (
                <Input
                  type="number"
                  min={opt.min}
                  max={opt.max}
                  value={Number(options[opt.key])}
                  onChange={(e) => setOptions((o) => ({ ...o, [opt.key]: Number(e.target.value) }))}
                  className="h-8 w-20 text-sm"
                />
              )}
            </label>
          ))}
        </div>

        <SheetPreview assets={scopedAssets} padding={padding} scale={scale} />

        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">{t('export.destination')}</span>
          <div className="flex gap-2">
            <Input
              value={destDir}
              onChange={(e) => setDestDir(e.target.value)}
              placeholder={t('export.destinationPlaceholder')}
              className="h-8 flex-1 text-sm"
            />
            {isElectron && (
              <Button size="sm" variant="outline" className="gap-1" onClick={() => void pickDir()}>
                <FolderOpen className="h-3.5 w-3.5" /> {t('export.browse')}
              </Button>
            )}
          </div>
        </label>

        <div className="flex items-center justify-between pt-1">
          <span className="text-[11px] text-muted-foreground">
            {t('export.count', { n: scopedAssets.length })}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>{t('export.cancel')}</Button>
            <Button size="sm" className="gap-1.5" disabled={busy || scopedAssets.length === 0} onClick={() => void doExport()}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              {t('export.action')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
