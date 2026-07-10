import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Loader2, RotateCcw, ShieldCheck, Wrench } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog.js';
import {
  applyAppPipelineRepair,
  previewAppPipelineRepair,
  undoAppPipelineRepair,
  type AppPipelineRepairPreview,
} from '../app-studio-api.js';

export function JourneyRepairDialog({
  sessionId,
  open,
  onOpenChange,
  onRepaired,
}: {
  sessionId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRepaired: () => void;
}) {
  const { t } = useTranslation('appStudio');
  const [preview, setPreview] = useState<AppPipelineRepairPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repairId, setRepairId] = useState<number | null>(null);

  const check = useCallback(async () => {
    setBusy(true);
    setError(null);
    setRepairId(null);
    try {
      setPreview(await previewAppPipelineRepair(sessionId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [sessionId]);

  useEffect(() => {
    if (!open) return;
    void check();
  }, [open, check]);

  const apply = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const result = await applyAppPipelineRepair(sessionId, preview.preview_token);
      setPreview((current) => current ? { ...current, report: result.report } : current);
      setRepairId(result.repair_id);
      onRepaired();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const undo = async () => {
    if (!repairId) return;
    setBusy(true);
    setError(null);
    try {
      await undoAppPipelineRepair(sessionId, repairId);
      onRepaired();
      await check();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const report = preview?.report ?? null;
  const statusLabel = (value: string) => (
    ['pending', 'active', 'review', 'approved', 'skipped'].includes(value)
      ? t(`stages.status.${value}`)
      : t(`pipeline.repairStatus.${value}`)
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wrench className="h-4 w-4 text-primary" />
            {t('pipeline.repairTitle')}
          </DialogTitle>
          <DialogDescription>{t('pipeline.repairDescription')}</DialogDescription>
        </DialogHeader>

        {busy && !report ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> {t('pipeline.repairChecking')}
          </div>
        ) : error ? (
          <div className="border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</div>
        ) : report && !report.changed ? (
          <div className="flex items-start gap-2 border border-emerald-300/60 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-950/30 dark:text-emerald-100">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
            <div><p className="font-medium">{t('pipeline.repairHealthy')}</p><p className="mt-0.5 text-xs opacity-80">{t('pipeline.repairHealthyHint')}</p></div>
          </div>
        ) : report ? (
          <div className="space-y-3">
            {repairId ? (
              <div className="flex items-start gap-2 border border-emerald-300/60 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-950/30 dark:text-emerald-100">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                <div><p className="font-medium">{t('pipeline.repairApplied')}</p><p className="mt-0.5 text-xs opacity-80">{t('pipeline.repairAppliedHint')}</p></div>
              </div>
            ) : (
              <div className="border bg-muted/30 p-3 text-sm">
                <p className="font-medium">{t('pipeline.repairFound', { count: report.changes.length })}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t('pipeline.repairSafety')}</p>
              </div>
            )}

            <div className="max-h-72 space-y-1.5 overflow-auto pr-1">
              {report.changes.map((change, index) => (
                <div key={`${change.stage_id ?? 'roadmap'}-${index}`} className="border px-3 py-2 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 font-medium">
                      {change.stage_id ? t(`stages.${change.stage_id}.name`) : t('pipeline.repairRoadmap')}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {statusLabel(change.before)} → {statusLabel(change.after)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{change.reason}</p>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>{t('pipeline.cancel')}</Button>
          {repairId ? (
            <Button variant="outline" onClick={() => void undo()} disabled={busy}>
              {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="mr-1.5 h-3.5 w-3.5" />}
              {t('pipeline.repairUndo')}
            </Button>
          ) : report?.changed ? (
            <Button onClick={() => void apply()} disabled={busy}>
              {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Wrench className="mr-1.5 h-3.5 w-3.5" />}
              {t('pipeline.repairApply')}
            </Button>
          ) : error ? (
            <Button variant="outline" onClick={() => void check()} disabled={busy}>{t('pipeline.repairRetry')}</Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
