/** Step 1 — pick a preset (Econômico / Equilibrado / Premium). */
import { useTranslation } from 'react-i18next';
import { Button } from '../../../components/ui/button.js';
import { cn } from '../../../lib/utils.js';
import { PRESETS, type PresetId } from './presets.js';

export function PresetStep({
  value,
  onChange,
  onCancel,
  onNext,
}: {
  value: PresetId;
  onChange: (id: PresetId) => void;
  onCancel: () => void;
  onNext: () => void;
}) {
  const { t } = useTranslation(['admin']);
  return (
    <div className="flex-1 flex flex-col gap-4">
      <p className="text-[13px] text-muted-foreground">{t('admin:pipelines.setup.presetIntro')}</p>
      <div className="grid gap-2">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onChange(p.id)}
            className={cn(
              'text-left rounded-lg border p-3 transition-colors',
              value === p.id ? 'border-primary bg-primary/5' : 'hover:bg-muted/40',
            )}
          >
            <div className="text-sm font-medium">{t(`admin:pipelines.setup.preset.${p.id}.title`)}</div>
            <div className="text-[12px] text-muted-foreground">{t(`admin:pipelines.setup.preset.${p.id}.desc`)}</div>
          </button>
        ))}
      </div>
      <div className="mt-auto flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={onCancel}>{t('admin:pipelines.setup.cancel')}</Button>
        <Button size="sm" onClick={onNext}>{t('admin:pipelines.setup.next')}</Button>
      </div>
    </div>
  );
}
