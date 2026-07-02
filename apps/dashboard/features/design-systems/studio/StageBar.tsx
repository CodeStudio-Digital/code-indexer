/**
 * Faixa fina acima do chat com o estado do pipeline: "Etapa 3/7 ·
 * Primitivos · 12/24" + ação primária da etapa corrente + atalho para a
 * aba Etapas. Substitui o strip genérico quando a sessão tem pipeline.
 */
import { useTranslation } from 'react-i18next';
import { ListChecks, Play } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import type { DesignSystemSessionDetail, DsRoadmapTier, DsStageId } from '../design-system-api.js';
import { startStage } from './stage-prompts.js';

const STAGE_TIER: Partial<Record<DsStageId, DsRoadmapTier>> = {
  primitives: 'primitive',
  composites: 'composite',
  templates: 'template',
};

export function StageBar({
  detail,
  onOpenStages,
  onChanged,
}: {
  detail: DesignSystemSessionDetail;
  onOpenStages: () => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation('designSystems');
  const { pipeline, session, project } = detail;
  if (!pipeline) return null;

  const current = pipeline.stages.find((s) => s.id === pipeline.current_stage) ?? null;
  const index = current ? pipeline.stages.findIndex((s) => s.id === current.id) : pipeline.stages.length;
  const tier = current ? STAGE_TIER[current.id] : undefined;
  const tierItems = tier ? pipeline.roadmap.filter((r) => r.tier === tier) : [];
  const progress = tierItems.length > 0
    ? ` · ${tierItems.filter((r) => r.recorded).length}/${tierItems.length}`
    : '';

  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b px-2 text-xs">
      <button
        onClick={onOpenStages}
        className="flex min-w-0 items-center gap-1.5 text-muted-foreground hover:text-foreground"
        title={t('tabs.stages')}
      >
        <ListChecks className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">
          {current
            ? `${t('pipeline.stageOf', { n: index + 1, total: pipeline.stages.length })} · ${t(`stages.${current.id}.name`)}${progress}`
            : t('pipeline.complete')}
        </span>
      </button>
      <div className="flex-1" />
      {current && (current.status === 'pending' || current.status === 'active') && project && (
        <Button
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={() => {
            void startStage(t, { dsSessionId: session.id, projectId: project.id, stage: current.id }).then(onChanged);
          }}
        >
          <Play className="mr-1 h-3 w-3" />
          {current.status === 'pending' ? t('pipeline.start') : t('pipeline.resend')}
        </Button>
      )}
      {current?.status === 'review' && (
        <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={onOpenStages}>
          {t('pipeline.reviewCta')}
        </Button>
      )}
    </div>
  );
}
