/**
 * Uma linha de etapa do StagesPanel: ícone de status, nome, resumo do
 * deliverable/feedback/issues do gate, e as ações do usuário — Aprovar /
 * Reabrir (com feedback) / Pular quando em revisão; botão de disparo
 * quando é a etapa corrente.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check, CheckCircle2, Circle, CircleDot, Eye, SkipForward, Play, RotateCcw,
} from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { cn } from '../../../lib/utils.js';
import type { DsPipelineStage, DsStageAction } from '../design-system-api.js';

const STATUS_ICON = {
  pending: Circle,
  active: CircleDot,
  review: Eye,
  approved: CheckCircle2,
  skipped: SkipForward,
} as const;

export function StageRow({
  stage,
  index,
  isCurrent,
  progressLabel,
  onAction,
  onStart,
}: {
  stage: DsPipelineStage;
  index: number;
  isCurrent: boolean;
  /** Ex.: "12/24" para tiers de componentes. */
  progressLabel?: string | null;
  onAction: (action: DsStageAction, feedback?: string) => void;
  onStart: () => void;
}) {
  const { t } = useTranslation('designSystems');
  const [reopening, setReopening] = useState(false);
  const [feedback, setFeedback] = useState('');
  const Icon = STATUS_ICON[stage.status];

  return (
    <div className={cn('rounded border px-2.5 py-2', isCurrent && 'border-primary/50 bg-primary/5')}>
      <div className="flex items-center gap-2">
        <Icon
          className={cn(
            'h-4 w-4 shrink-0',
            stage.status === 'approved' && 'text-green-600',
            stage.status === 'review' && 'text-amber-500',
            stage.status === 'active' && 'text-primary',
            (stage.status === 'pending' || stage.status === 'skipped') && 'text-muted-foreground',
          )}
        />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {index + 1}. {t(`stages.${stage.id}.name`)}
          {progressLabel && <span className="ml-2 font-mono text-xs text-muted-foreground">{progressLabel}</span>}
        </span>
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {t(`stages.status.${stage.status}`)}
        </span>
      </div>

      {stage.summary && <p className="mt-1 pl-6 text-xs text-muted-foreground">{stage.summary}</p>}
      {stage.feedback && stage.status === 'active' && (
        <p className="mt-1 pl-6 text-xs text-amber-600">{t('pipeline.feedbackLabel')}: {stage.feedback}</p>
      )}
      {stage.gate && !stage.gate.ok && (
        <ul className="mt-1 space-y-0.5 pl-6 text-xs text-red-600">
          {stage.gate.issues.map((issue, i) => <li key={i}>• {issue}</li>)}
        </ul>
      )}

      {isCurrent && (stage.status === 'pending' || stage.status === 'active') && (
        <div className="mt-2 flex gap-1.5 pl-6">
          <Button size="sm" className="h-6 text-xs" onClick={onStart}>
            <Play className="mr-1 h-3 w-3" />
            {stage.status === 'pending' ? t('pipeline.start') : t('pipeline.resend')}
          </Button>
          <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => onAction('skip')}>
            {t('pipeline.skip')}
          </Button>
        </div>
      )}

      {stage.status === 'review' && (
        <div className="mt-2 space-y-1.5 pl-6">
          {reopening ? (
            <>
              <textarea
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder={t('pipeline.feedbackPlaceholder')}
                className="h-16 w-full rounded border bg-background px-2 py-1 text-xs"
              />
              <div className="flex gap-1.5">
                <Button size="sm" variant="outline" className="h-6 text-xs" onClick={() => { onAction('reopen', feedback); setReopening(false); setFeedback(''); }}>
                  {t('pipeline.reopenConfirm')}
                </Button>
                <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => setReopening(false)}>
                  {t('actions.cancel')}
                </Button>
              </div>
            </>
          ) : (
            <div className="flex gap-1.5">
              <Button size="sm" className="h-6 text-xs" onClick={() => onAction('approve')}>
                <Check className="mr-1 h-3 w-3" /> {t('pipeline.approve')}
              </Button>
              <Button size="sm" variant="outline" className="h-6 text-xs" onClick={() => setReopening(true)}>
                <RotateCcw className="mr-1 h-3 w-3" /> {t('pipeline.reopen')}
              </Button>
              <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => onAction('skip')}>
                {t('pipeline.skip')}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
