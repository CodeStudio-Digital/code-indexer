/**
 * Step 2 — per-capability provider + model selection. The layperson never
 * sees temperature/max_tokens; each ON bucket needs a provider and a model
 * that actually exists, or Apply stays disabled.
 */
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../../components/ui/button.js';
import { Switch } from '../../../components/ui/switch.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select.js';
import { cn } from '../../../lib/utils.js';
import { metaFor } from '../pipeline-filter/capability-meta.js';
import { WIZARD_BUCKETS, type SetupController } from './use-setup-state.js';

export function BucketStep({
  ctrl,
  onBack,
  onNext,
}: {
  ctrl: SetupController;
  onBack: () => void;
  onNext: () => void;
}) {
  const { t } = useTranslation(['admin']);
  const { state, providersFor, modelsFor, setBucket, isBucketValid, canApply } = ctrl;

  return (
    <div className="flex-1 flex flex-col gap-3">
      <p className="text-[13px] text-muted-foreground">{t('admin:pipelines.setup.bucketsIntro')}</p>
      <div className="space-y-2 overflow-y-auto pr-1 max-h-[360px]">
        {WIZARD_BUCKETS.map((b) => {
          const sel = state.buckets[b.kind];
          if (!sel) return null;
          const meta = metaFor(b.kind);
          const Icon = meta?.icon;
          const provs = providersFor(b.kind);
          const models = sel.providerId ? modelsFor(sel.providerId) : [];
          const noProvider = provs.length === 0;
          const valid = isBucketValid(b.kind);
          return (
            <div key={b.kind} className="rounded-lg border p-3 space-y-2">
              <div className="flex items-center gap-2">
                <Switch
                  checked={sel.enabled}
                  disabled={b.required}
                  onCheckedChange={(on) => setBucket(b.kind, { enabled: on })}
                />
                {Icon && <Icon className="h-4 w-4 text-muted-foreground" />}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">{t(`admin:pipelines.capability.${meta?.i18nKey}`)}</div>
                  <div className="text-[11px] text-muted-foreground">{t(`admin:pipelines.setup.bucketDesc.${b.kind}`)}</div>
                </div>
              </div>

              {sel.enabled && (noProvider ? (
                <div className="text-[11px] text-amber-600 flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3 shrink-0" /> {t('admin:pipelines.setup.noProvider')}
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap gap-2">
                    <Select
                      value={sel.providerId}
                      onValueChange={(v) => setBucket(b.kind, { providerId: v, modelId: '' })}
                    >
                      <SelectTrigger className="h-8 w-[160px]">
                        <SelectValue placeholder={t('admin:pipelines.setup.pickProvider')} />
                      </SelectTrigger>
                      <SelectContent>
                        {provs.map((p) => (
                          <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select
                      value={sel.modelId}
                      onValueChange={(v) => setBucket(b.kind, { modelId: v })}
                      disabled={!sel.providerId || models.length === 0}
                    >
                      <SelectTrigger className={cn('h-8 w-[210px]', !valid && 'border-amber-500')}>
                        <SelectValue placeholder={t('admin:pipelines.setup.pickModel')} />
                      </SelectTrigger>
                      <SelectContent>
                        {models.map((m) => (
                          <SelectItem key={m.model_id} value={m.model_id}>{m.model_id}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {!sel.modelId && (
                    <div className="text-[11px] text-amber-600">{t('admin:pipelines.setup.modelMissing')}</div>
                  )}
                </>
              ))}
            </div>
          );
        })}
      </div>

      <div className="mt-auto flex items-center justify-between pt-1">
        <Button variant="ghost" size="sm" onClick={onBack}>{t('admin:pipelines.setup.back')}</Button>
        <Button size="sm" onClick={onNext} disabled={!canApply}>{t('admin:pipelines.setup.next')}</Button>
      </div>
    </div>
  );
}
