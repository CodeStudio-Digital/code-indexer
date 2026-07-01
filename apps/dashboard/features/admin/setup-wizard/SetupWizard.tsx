/**
 * Guided "Configuração assistida" modal — lets a non-expert configure every
 * pipeline at once by picking a preset + a provider/model per capability
 * bucket. The dense grid stays as the expert surface; this is the easy path.
 *
 * Steps render their own footers (OnboardingWizard pattern); this shell only
 * owns the dialog, the step indicator, and step routing.
 */
import { Loader2, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog.js';
import { cn } from '../../../lib/utils.js';
import { useSetupState } from './use-setup-state.js';
import { PresetStep } from './PresetStep.js';
import { BucketStep } from './BucketStep.js';
import { ReviewStep } from './ReviewStep.js';

function Stepper({ index, labels }: { index: number; labels: string[] }) {
  return (
    <div className="flex items-center gap-2 px-1">
      {labels.map((label, i) => (
        <div key={label} className="inline-flex items-center gap-1.5">
          <span
            className={cn(
              'h-5 w-5 rounded-full text-[10px] grid place-items-center font-semibold',
              i < index && 'bg-primary text-primary-foreground',
              i === index && 'border-2 border-primary text-primary',
              i > index && 'border border-border text-muted-foreground',
            )}
          >
            {i + 1}
          </span>
          <span className={cn('text-[11px]', i === index ? 'text-foreground font-medium' : 'text-muted-foreground')}>
            {label}
          </span>
          {i < labels.length - 1 && <span className="w-5 h-px bg-border" aria-hidden />}
        </div>
      ))}
    </div>
  );
}

export function SetupWizard({
  open,
  onClose,
  onApplied,
}: {
  open: boolean;
  onClose: () => void;
  onApplied: () => void;
}) {
  const { t } = useTranslation(['admin']);
  const ctrl = useSetupState();
  const { state, setStep } = ctrl;
  const stepIndex = state.step === 'preset' ? 0 : state.step === 'buckets' ? 1 : 2;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            {t('admin:pipelines.setup.title')}
          </DialogTitle>
        </DialogHeader>

        <Stepper
          index={stepIndex}
          labels={[
            t('admin:pipelines.setup.steps.preset'),
            t('admin:pipelines.setup.steps.buckets'),
            t('admin:pipelines.setup.steps.review'),
          ]}
        />

        <div className="min-h-[340px] flex flex-col">
          {ctrl.loading ? (
            <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mr-2" /> {t('admin:pipelines.loading')}
            </div>
          ) : (
            <>
              {state.step === 'preset' && (
                <PresetStep
                  value={state.preset}
                  onChange={ctrl.choosePreset}
                  onCancel={onClose}
                  onNext={() => setStep('buckets')}
                />
              )}
              {state.step === 'buckets' && (
                <BucketStep ctrl={ctrl} onBack={() => setStep('preset')} onNext={() => setStep('review')} />
              )}
              {(state.step === 'review' || state.step === 'applying' || state.step === 'done') && (
                <ReviewStep
                  ctrl={ctrl}
                  onBack={() => setStep('buckets')}
                  onClose={() => { onApplied(); onClose(); }}
                />
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
