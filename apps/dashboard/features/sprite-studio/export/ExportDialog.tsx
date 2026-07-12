import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Download, FileText, FolderOpen, Loader2 } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '../../../components/ui/dialog.js';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { toast } from '../../../components/ui/prompt-dialog.js';
import * as api from '../api.js';
import type { SpriteAsset } from '../types.js';
import { EXPORT_FORMATS, defaultOptions, findFormat } from './export-formats.js';
import { SheetPreview } from './SheetPreview.js';

type Scope = 'animation' | 'asset' | 'assetAnimations' | 'category' | 'approved';
const selectCls = 'h-8 rounded border bg-background px-2 text-sm';
const absolutePath = (value: string): boolean => /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(value);

export function ExportDialog({
  open, onClose, projectId, assets, activeAsset, activeAnimation,
}: {
  open: boolean;
  onClose: () => void;
  projectId: number;
  assets: SpriteAsset[];
  activeAsset: SpriteAsset | null;
  activeAnimation?: { id: number; name: string } | null;
}) {
  const { t } = useTranslation('spriteStudio');
  const [scope, setScope] = useState<Scope>(activeAnimation ? 'animation' : activeAsset ? 'asset' : 'approved');
  const [formatId, setFormatId] = useState('spritesheet-json');
  const [options, setOptions] = useState<Record<string, number | boolean>>(
    () => defaultOptions(findFormat('spritesheet-json')),
  );
  const [destDir, setDestDir] = useState('');
  const [busy, setBusy] = useState(false);
  const [planBusy, setPlanBusy] = useState(false);
  const [plan, setPlan] = useState<api.ExportPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const format = findFormat(formatId);
  const isElectron = typeof window !== 'undefined' && !!window.electronAPI?.openDirectory;

  useEffect(() => {
    if (!open) return;
    setScope(activeAnimation ? 'animation' : activeAsset ? 'asset' : 'approved');
  }, [open, activeAsset, activeAnimation]);
  useEffect(() => setOptions(defaultOptions(format)), [formatId]); // eslint-disable-line react-hooks/exhaustive-deps

  const scopedAssets = useMemo(() => {
    if (scope === 'asset' || scope === 'assetAnimations' || scope === 'animation') return activeAsset ? [activeAsset] : [];
    if (scope === 'category') return activeAsset ? assets.filter((a) => a.category === activeAsset.category) : [];
    return assets.filter((a) => a.status === 'approved');
  }, [scope, activeAsset, assets]);

  const request = useMemo<api.ExportRequest | null>(() => {
    if ((scope !== 'approved' && !activeAsset) || (scope === 'animation' && !activeAnimation)) return null;
    const exportScope: api.ExportScopeV2 = scope === 'animation'
      ? { kind: 'animation', assetId: activeAsset!.id, animationIds: [activeAnimation!.id] }
      : scope === 'assetAnimations'
        ? { kind: 'asset', assetIds: [activeAsset!.id], includeAnimations: true }
        : scope === 'asset'
          ? { kind: 'asset', assetIds: [activeAsset!.id], includeAnimations: false }
          : scope === 'category'
            ? { kind: 'category', category: activeAsset!.category, includeAnimations: false }
            : { kind: 'approved', includeAnimations: false };
    const value = destDir.trim();
    const target: api.ExportTargetV2 = absolutePath(value)
      ? { kind: 'absolute', path: value }
      : { kind: 'project', ...(value ? { relativeDir: value } : {}) };
    return { version: 2, scope: exportScope, target, format: formatId, options };
  }, [scope, activeAsset, activeAnimation, destDir, formatId, options]);

  useEffect(() => {
    if (!open || !request || scopedAssets.length === 0) { setPlan(null); return; }
    let cancelled = false;
    const timer = setTimeout(() => {
      setPlanBusy(true); setPlanError(null);
      void api.planExport(projectId, request)
        .then((value) => { if (!cancelled) setPlan(value); })
        .catch((error) => { if (!cancelled) { setPlan(null); setPlanError((error as Error).message); } })
        .finally(() => { if (!cancelled) setPlanBusy(false); });
    }, 180);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [open, projectId, request, scopedAssets.length]);

  const pickDir = async () => {
    if (!isElectron) return;
    try { const dir = await window.electronAPI!.openDirectory!(); if (dir) setDestDir(dir); } catch { /* cancelled */ }
  };
  const doExport = async () => {
    if (!request) return;
    setBusy(true);
    try {
      const result = await api.exportAssets(projectId, request);
      toast.success(t('export.done', { n: result.files.length })); onClose();
    } catch (error) {
      toast.error(t('export.failed'), { description: error instanceof Error ? error.message : String(error) });
    } finally { setBusy(false); }
  };

  const padding = typeof options.padding === 'number' ? options.padding : 0;
  const scale = typeof options.scale === 'number' ? options.scale : 1;

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Download className="h-4 w-4" /> {t('export.title')}</DialogTitle>
          <DialogDescription>{t('export.description')}</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">{t('export.scope.label')}</span>
            <select className={selectCls} value={scope} onChange={(e) => setScope(e.target.value as Scope)} aria-label={t('export.scope.label')}>
              <option value="animation" disabled={!activeAnimation}>{t('export.scope.animation', { name: activeAnimation?.name ?? '' })}</option>
              <option value="asset" disabled={!activeAsset}>{t('export.scope.asset')}</option>
              <option value="assetAnimations" disabled={!activeAsset}>{t('export.scope.assetAnimations')}</option>
              <option value="category" disabled={!activeAsset}>{t('export.scope.category')}</option>
              <option value="approved">{t('export.scope.approved')}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">{t('export.formatLabel')}</span>
            <select className={selectCls} value={formatId} onChange={(e) => setFormatId(e.target.value)} aria-label={t('export.formatLabel')}>
              {EXPORT_FORMATS.map((item) => <option key={item.id} value={item.id}>{t(`export.format.${item.labelKey}`)}</option>)}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap gap-3 rounded border bg-muted/10 p-2">
          {format.options.map((option) => (
            <label key={option.key} className="flex items-center gap-2 text-xs">
              <span className="text-muted-foreground">{t(`export.options.${option.labelKey}`)}</span>
              {option.type === 'boolean' ? (
                <input type="checkbox" checked={!!options[option.key]}
                  onChange={(e) => setOptions((current) => ({ ...current, [option.key]: e.target.checked }))}
                  className="h-4 w-4 accent-primary" />
              ) : (
                <Input type="number" min={option.min} max={option.max} value={Number(options[option.key])}
                  onChange={(e) => setOptions((current) => ({ ...current, [option.key]: Number(e.target.value) }))}
                  className="h-8 w-20 text-sm" />
              )}
            </label>
          ))}
        </div>
        <SheetPreview assets={scopedAssets} padding={padding} scale={scale} />
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">{t('export.destination')}</span>
          <div className="flex gap-2">
            <Input value={destDir} onChange={(e) => setDestDir(e.target.value)} placeholder={t('export.destinationPlaceholder')} className="h-8 flex-1 text-sm" />
            {isElectron && <Button size="sm" variant="outline" className="gap-1" onClick={() => void pickDir()}><FolderOpen className="h-3.5 w-3.5" /> {t('export.browse')}</Button>}
          </div>
          <span className="text-[11px] text-muted-foreground">{t('export.destinationHint')}</span>
        </label>
        <div className="min-h-20 rounded border bg-background/50 p-2 text-xs">
          {planBusy ? <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />{t('export.plan.loading')}</div>
            : planError ? <div className="text-red-400">{planError}</div>
              : plan ? <>
                <div className="mb-2 flex flex-wrap gap-3 text-muted-foreground">
                  <span>{t('export.plan.assets', { n: plan.assetCount })}</span><span>{t('export.plan.frames', { n: plan.frameCount })}</span><span>{t('export.plan.animations', { n: plan.animationCount })}</span>
                </div>
                <div className="max-h-24 space-y-1 overflow-auto">{plan.files.map((file) => <div key={file.path} className="flex items-center gap-2"><FileText className="h-3 w-3" /><span className="truncate">{file.path}</span><span className="ml-auto text-muted-foreground">{file.bytes} B</span></div>)}</div>
                {plan.warnings.map((warning) => <div key={warning} className="mt-2 flex items-center gap-1 text-amber-400"><AlertTriangle className="h-3 w-3" />{t(`export.warning.${warning}`)}</div>)}
              </> : <span className="text-muted-foreground">{t('export.plan.empty')}</span>}
        </div>
        <div className="flex items-center justify-between pt-1">
          <span className="text-xs text-muted-foreground">{t('export.count', { n: scopedAssets.length })}</span>
          <div className="flex gap-2"><Button variant="ghost" size="sm" onClick={onClose}>{t('export.cancel')}</Button>
            <Button size="sm" className="gap-1.5" disabled={busy || planBusy || !plan || !!planError} onClick={() => void doExport()}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}{t('export.action')}
            </Button></div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
