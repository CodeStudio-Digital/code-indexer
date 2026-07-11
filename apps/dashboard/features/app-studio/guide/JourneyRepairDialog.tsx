import { useCallback, useEffect, useState, type ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  FolderCog,
  ListChecks,
  Loader2,
  RotateCcw,
  ShieldCheck,
  Wrench,
} from 'lucide-react';
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
  applyAppRepair,
  previewAppRepair,
  undoAppRepair,
  type AppRepairArea,
  type AppRepairPreview,
} from '../app-studio-api.js';

const AREA_ICONS: Record<AppRepairArea['id'], ComponentType<{ className?: string }>> = {
  workspace: FolderCog,
  database: Database,
  pipeline: ListChecks,
};

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
  const [preview, setPreview] = useState<AppRepairPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repairId, setRepairId] = useState<number | null>(null);

  const check = useCallback(async () => {
    setBusy(true);
    setError(null);
    setPreview(null);
    setRepairId(null);
    try {
      setPreview(await previewAppRepair(sessionId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [sessionId]);

  useEffect(() => {
    if (open) void check();
  }, [open, check]);

  const apply = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const result = await applyAppRepair(sessionId, preview.preview_token);
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
      await undoAppRepair(sessionId, repairId);
      onRepaired();
      await check();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const report = preview?.report ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
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
        ) : report ? (
          <div className="space-y-3">
            {repairId ? (
              <div className="flex items-start gap-2 border border-emerald-300/60 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-950/30 dark:text-emerald-100">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                <div><p className="font-medium">{t('pipeline.repairApplied')}</p><p className="mt-0.5 text-xs opacity-80">{t('pipeline.repairAppliedHint')}</p></div>
              </div>
            ) : report.healthy ? (
              <div className="flex items-start gap-2 border border-emerald-300/60 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-950/30 dark:text-emerald-100">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
                <div><p className="font-medium">{t('pipeline.repairHealthy')}</p><p className="mt-0.5 text-xs opacity-80">{t('pipeline.repairHealthyHint')}</p></div>
              </div>
            ) : report.changed ? (
              <div className="border bg-muted/30 p-3 text-sm">
                <p className="font-medium">{t('pipeline.repairFound', { count: report.action_count })}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t('pipeline.repairSafety')}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t('pipeline.repairPreserves')}</p>
              </div>
            ) : (
              <div className="flex items-start gap-2 border border-amber-300/60 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-500/30 dark:bg-amber-950/30 dark:text-amber-100">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <div><p className="font-medium">{t('pipeline.repairNeedsSpecialist')}</p><p className="mt-0.5 text-xs opacity-80">{t('pipeline.repairNeedsSpecialistHint')}</p></div>
              </div>
            )}

            <div className="max-h-80 divide-y overflow-auto border">
              {report.areas.map((area) => {
                const Icon = AREA_ICONS[area.id];
                return (
                  <section key={area.id} className="p-3">
                    <div className="flex items-center gap-2">
                      <Icon className="h-4 w-4 text-muted-foreground" />
                      <h4 className="min-w-0 flex-1 text-sm font-medium">{t(`pipeline.repairAreas.${area.id}`)}</h4>
                      <span className="text-[11px] font-medium text-muted-foreground">{t(`pipeline.repairAreaStatus.${area.status}`)}</span>
                    </div>
                    {area.issues.length === 0 && area.actions.length === 0 ? (
                      <p className="mt-1.5 pl-6 text-xs text-muted-foreground">{t('pipeline.repairAreaHealthy')}</p>
                    ) : (
                      <div className="mt-2 space-y-2 pl-6">
                        {area.issues.map((issue, index) => (
                          <div key={`${issue.code}-${index}`} className="text-xs text-muted-foreground">
                            <p className={issue.repairable ? '' : 'text-amber-700 dark:text-amber-300'}>
                              {t(`pipeline.repairIssues.${issue.code}`, { defaultValue: issue.message })}
                            </p>
                          </div>
                        ))}
                        {area.actions.length > 0 && (
                          <div className="border-l-2 border-primary/40 pl-2 text-xs">
                            <p className="font-medium">{t('pipeline.repairWillDo')}</p>
                            {area.actions.map((action, index) => <p key={`${action.title}-${index}`} className="mt-0.5 text-muted-foreground">{action.reason}</p>)}
                          </div>
                        )}
                      </div>
                    )}
                  </section>
                );
              })}
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
