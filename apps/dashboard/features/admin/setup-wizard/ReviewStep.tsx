/** Step 3 — review the per-capability picks, apply, then show the result. */
import { CheckCircle2, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../../components/ui/button.js';
import { metaFor } from '../pipeline-filter/capability-meta.js';
import { WIZARD_BUCKETS, type SetupController } from './use-setup-state.js';

export function ReviewStep({
  ctrl,
  onBack,
  onClose,
}: {
  ctrl: SetupController;
  onBack: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(['admin']);
  const { state, providers, apply, canApply } = ctrl;
  const active = WIZARD_BUCKETS.filter((b) => state.buckets[b.kind]?.enabled);

  if (state.step === 'applying') {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" />
        {t('admin:pipelines.setup.applying')}
      </div>
    );
  }

  if (state.step === 'done' && state.result) {
    const entries = Object.entries(state.result.byCapability);
    return (
      <div className="flex-1 flex flex-col gap-4">
        <div className="flex flex-col items-center gap-2 pt-2 text-center">
          <CheckCircle2 className="h-8 w-8 text-emerald-500" />
          <div className="text-base font-semibold">{t('admin:pipelines.setup.appliedTitle')}</div>
          <p className="text-[13px] text-muted-foreground">
            {t('admin:pipelines.setup.appliedCount', { count: state.result.applied })}
          </p>
        </div>
        <div className="space-y-1">
          {entries.map(([kind, count]) => (
            <div key={kind} className="flex items-center justify-between rounded border px-3 py-1.5 text-sm">
              <span>{t(`admin:pipelines.capability.${metaFor(kind as never)?.i18nKey}`)}</span>
              <span className="tabular-nums text-muted-foreground">{count}</span>
            </div>
          ))}
        </div>
        <div className="mt-auto flex justify-end">
          <Button size="sm" onClick={onClose}>{t('admin:pipelines.setup.close')}</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col gap-3">
      <p className="text-[13px] text-muted-foreground">
        {t('admin:pipelines.setup.reviewIntro', { count: active.length })}
      </p>
      <div className="space-y-1.5">
        {active.map((b) => {
          const sel = state.buckets[b.kind];
          const prov = providers.find((p) => p.id === sel.providerId);
          return (
            <div key={b.kind} className="flex items-center justify-between gap-2 rounded border px-3 py-2 text-sm">
              <span>{t(`admin:pipelines.capability.${metaFor(b.kind)?.i18nKey}`)}</span>
              <span className="font-mono text-[11px] text-muted-foreground truncate">
                {prov?.name} · {sel.modelId}
              </span>
            </div>
          );
        })}
      </div>
      <p className="text-[11px] text-muted-foreground">{t('admin:pipelines.setup.reviewNote')}</p>
      {state.error && <div className="text-xs text-red-500">{state.error}</div>}
      <div className="mt-auto flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={onBack}>{t('admin:pipelines.setup.back')}</Button>
        <Button size="sm" onClick={() => void apply()} disabled={!canApply}>{t('admin:pipelines.setup.apply')}</Button>
      </div>
    </div>
  );
}
