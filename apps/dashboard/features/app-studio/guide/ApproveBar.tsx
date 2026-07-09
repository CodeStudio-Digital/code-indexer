/**
 * Ações de revisão do leigo: "Aprovar e continuar" (primário, grande) e
 * "Quero mudar algo" (abre textarea de feedback → reopen). Compartilhado
 * entre as linhas da jornada e o SpecPanel.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, RotateCcw } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';

export function ApproveBar({
  onApprove,
  onReopen,
  busy = false,
}: {
  onApprove: () => void;
  onReopen: (feedback: string) => void;
  busy?: boolean;
}) {
  const { t } = useTranslation('appStudio');
  const [changing, setChanging] = useState(false);
  const [feedback, setFeedback] = useState('');

  if (changing) {
    return (
      <div className="space-y-1.5">
        <textarea
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder={t('pipeline.feedbackPlaceholder')}
          className="h-16 w-full rounded border bg-background px-2 py-1 text-xs"
          autoFocus
        />
        <div className="flex gap-1.5">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            disabled={busy || !feedback.trim()}
            onClick={() => {
              onReopen(feedback.trim());
              setChanging(false);
              setFeedback('');
            }}
          >
            {t('pipeline.reopenConfirm')}
          </Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setChanging(false)}>
            {t('pipeline.cancel')}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <Button size="sm" className="h-8 flex-1 text-xs font-semibold" disabled={busy} onClick={onApprove}>
        <Check className="mr-1 h-3.5 w-3.5" /> {t('pipeline.approve')}
      </Button>
      <Button size="sm" variant="outline" className="h-8 text-xs" disabled={busy} onClick={() => setChanging(true)}>
        <RotateCcw className="mr-1 h-3 w-3" /> {t('pipeline.requestChanges')}
      </Button>
    </div>
  );
}
