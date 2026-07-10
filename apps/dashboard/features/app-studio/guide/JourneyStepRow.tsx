/**
 * Uma etapa da jornada do leigo: bolinha de status com conector de
 * timeline, nome humano + tagline, caixa "Sua vez" quando é a corrente,
 * ApproveBar em review e explainer collapsible. Sem botão "Pular" (pulos
 * são decisão da spec, não do leigo). Issues de gate (texto técnico do
 * agente) ficam atrás de um <details> discreto.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Circle, CircleDot, Eye, Play, Rocket, RotateCcw, SkipForward } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import { cn } from '../../../lib/utils.js';
import type { AppPipelineStage, AppStageAction } from '../app-studio-api.js';
import { ApproveBar } from './ApproveBar.js';
import { ExplainerCard } from './ExplainerCard.js';

const STATUS_ICON = {
  pending: Circle,
  active: CircleDot,
  review: Eye,
  approved: CheckCircle2,
  skipped: SkipForward,
} as const;

export function JourneyStepRow({
  stage,
  index,
  isLast,
  isCurrent,
  progressLabel,
  busy,
  onAction,
  onStart,
  onOpenPublish,
}: {
  stage: AppPipelineStage;
  index: number;
  isLast: boolean;
  isCurrent: boolean;
  /** Ex.: "2/4" para etapas com roadmap (design/backend). */
  progressLabel?: string | null;
  busy: boolean;
  onAction: (action: AppStageAction, feedback?: string) => void;
  /** Dispara o prompt da etapa no chat (etapas conversáveis). */
  onStart: () => void;
  /** launch: a ação é abrir a aba Publicar, não mandar prompt. */
  onOpenPublish: () => void;
}) {
  const { t } = useTranslation('appStudio');
  const [reopening, setReopening] = useState(false);
  const [reopenFeedback, setReopenFeedback] = useState('');
  const Icon = STATUS_ICON[stage.status];
  const isLaunch = stage.id === 'launch';

  return (
    <div className="flex gap-2.5">
      {/* Timeline: bolinha + conector vertical */}
      <div className="flex flex-col items-center">
        <Icon
          className={cn(
            'h-5 w-5 shrink-0',
            stage.status === 'approved' && 'text-green-600',
            stage.status === 'review' && 'text-amber-500',
            stage.status === 'active' && 'text-primary',
            (stage.status === 'pending' || stage.status === 'skipped') && 'text-muted-foreground/60',
          )}
        />
        {!isLast && <div className="w-px flex-1 bg-border" />}
      </div>

      <div className={cn('mb-3 min-w-0 flex-1 rounded border px-3 py-2', isCurrent && 'border-primary/50 bg-primary/5')}>
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {index + 1}. {t(`stages.${stage.id}.name`)}
            {progressLabel && <span className="ml-2 font-mono text-xs text-muted-foreground">{progressLabel}</span>}
          </span>
          {stage.status === 'approved' && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 shrink-0 px-2 text-[11px]"
              disabled={busy}
              onClick={() => setReopening(true)}
            >
              <RotateCcw className="mr-1 h-3 w-3" />
              {t('pipeline.editStep')}
            </Button>
          )}
          <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
            {t(`stages.status.${stage.status}`)}
          </span>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{t(`stages.${stage.id}.tagline`)}</p>

        {stage.summary && stage.status !== 'pending' && (
          <p className="mt-1.5 rounded bg-muted/40 px-2 py-1 text-xs">{stage.summary}</p>
        )}
        {stage.feedback && stage.status === 'active' && (
          <p className="mt-1 text-xs text-amber-600">“{stage.feedback}”</p>
        )}
        {stage.gate && !stage.gate.ok && stage.status === 'active' && (
          <details className="mt-1 text-xs text-muted-foreground">
            <summary className="cursor-pointer">{t('pipeline.gateIssues')} ({stage.gate.issues.length})</summary>
            <ul className="mt-1 space-y-0.5 font-mono text-[11px]">
              {stage.gate.issues.map((issue, i) => (
                <li key={i}>• {issue}</li>
              ))}
            </ul>
          </details>
        )}
        {reopening && stage.status === 'approved' && (
          <div className="mt-2 space-y-1.5 rounded border border-amber-300/60 bg-amber-50/70 p-2 text-xs dark:border-amber-400/30 dark:bg-amber-950/30">
            <p className="text-amber-900 dark:text-amber-200">{t('pipeline.reopenApprovedHint')}</p>
            <textarea
              value={reopenFeedback}
              onChange={(e) => setReopenFeedback(e.target.value)}
              placeholder={t('pipeline.reopenApprovedPlaceholder')}
              className="h-16 w-full rounded border bg-background px-2 py-1 text-xs"
              autoFocus
            />
            <div className="flex gap-1.5">
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                disabled={busy || !reopenFeedback.trim()}
                onClick={() => {
                  onAction('reopen', reopenFeedback.trim());
                  setReopening(false);
                  setReopenFeedback('');
                }}
              >
                {t('pipeline.reopenApprovedConfirm')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs"
                onClick={() => {
                  setReopening(false);
                  setReopenFeedback('');
                }}
              >
                {t('pipeline.cancel')}
              </Button>
            </div>
          </div>
        )}

        {isCurrent && (
          <div className="mt-2 space-y-2">
            <div className="rounded border border-amber-300/60 bg-amber-50 px-2 py-1.5 text-xs text-amber-900 dark:border-amber-400/30 dark:bg-amber-950/40 dark:text-amber-200">
              <span className="font-semibold">{t('pipeline.yourTurn')}:</span> {t(`stages.${stage.id}.userAction`)}
            </div>
            {(stage.status === 'pending' || stage.status === 'active') && (
              <Button
                size="sm"
                className="h-7 text-xs"
                disabled={busy}
                onClick={isLaunch ? onOpenPublish : onStart}
              >
                {isLaunch ? <Rocket className="mr-1 h-3 w-3" /> : <Play className="mr-1 h-3 w-3" />}
                {isLaunch
                  ? t('tabs.publish')
                  : stage.status === 'pending'
                    ? t('pipeline.start')
                    : t('pipeline.resend')}
              </Button>
            )}
            {stage.status === 'review' && (
              <ApproveBar
                busy={busy}
                onApprove={() => onAction('approve')}
                onReopen={(feedback) => onAction('reopen', feedback)}
              />
            )}
            <ExplainerCard stageId={stage.id} />
          </div>
        )}
      </div>
    </div>
  );
}
