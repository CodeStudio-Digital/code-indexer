/**
 * Faixa fina acima do chat: "Etapa 2/6 · Montar as telas" + a ação da vez
 * (começar/continuar/revisar) — o leigo nunca fica sem saber o próximo
 * passo. Clique no texto abre a aba Guia.
 */
import { useTranslation } from 'react-i18next';
import { ListChecks, Play, Rocket } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import type { AppStudioSessionDetail } from './app-studio-api.js';
import { isPromptableStage, startAppStage } from './stage-prompts.js';

export function GuideBar({
  detail,
  discoveryExtra,
  onOpenGuide,
  onOpenPublish,
  onChanged,
}: {
  detail: AppStudioSessionDetail;
  discoveryExtra?: string | null;
  onOpenGuide: () => void;
  onOpenPublish: () => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation('appStudio');
  const { pipeline, session, project } = detail;
  if (!pipeline) return null;

  const current = pipeline.stages.find((s) => s.id === pipeline.current_stage) ?? null;
  const index = current ? pipeline.stages.findIndex((s) => s.id === current.id) : pipeline.stages.length;

  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b px-2 text-xs">
      <button
        onClick={onOpenGuide}
        className="flex min-w-0 items-center gap-1.5 text-muted-foreground hover:text-foreground"
        title={t('tabs.guide')}
      >
        <ListChecks className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">
          {current
            ? `${t('pipeline.stageOf', { n: index + 1, total: pipeline.stages.length })} · ${t(`stages.${current.id}.name`)}`
            : t('pipeline.complete')}
        </span>
      </button>
      <div className="flex-1" />
      {current && (current.status === 'pending' || current.status === 'active') && project && (
        <Button
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={() => {
            if (current.id === 'launch' || !isPromptableStage(current.id)) {
              onOpenPublish();
              return;
            }
            void startAppStage(t, {
              sessionId: session.id,
              projectId: project.id,
              stage: current.id,
              extra: current.id === 'discovery' ? discoveryExtra : null,
            }).then(onChanged);
          }}
        >
          {current.id === 'launch' ? <Rocket className="mr-1 h-3 w-3" /> : <Play className="mr-1 h-3 w-3" />}
          {current.id === 'launch'
            ? t('tabs.publish')
            : current.status === 'pending'
              ? t('pipeline.start')
              : t('pipeline.resend')}
        </Button>
      )}
      {current?.status === 'review' && (
        <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={onOpenGuide}>
          {t('pipeline.reviewCta')}
        </Button>
      )}
    </div>
  );
}
