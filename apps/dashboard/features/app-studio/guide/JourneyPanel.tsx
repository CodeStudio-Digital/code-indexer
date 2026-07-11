/**
 * Painel "Guia" — a jornada de 6 etapas do leigo em timeline vertical.
 * Aprovação acontece AQUI (ApproveBar nas linhas em review; o agente não
 * tem tool de aprovar). Sessões sem pipeline ganham o botão de init.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Sparkles, Wrench } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import {
  initAppPipeline,
  patchAppStage,
  recheckAppStage,
  type AppRoadmapTier,
  type AppStageAction,
  type AppStageId,
  type AppStudioSessionDetail,
} from '../app-studio-api.js';
import { activateAppStage, isPromptableStage, specialistForStage, stagePrompt, startAppStage } from '../stage-prompts.js';
import { JourneyStepRow } from './JourneyStepRow.js';
import { SpecPanel } from './SpecPanel.js';
import { JourneyRepairDialog } from './JourneyRepairDialog.js';

const STAGE_TIER: Partial<Record<AppStageId, AppRoadmapTier>> = {
  design: 'screen',
  backend: 'api',
};

export function JourneyPanel({
  detail,
  discoveryExtra,
  onChanged,
  onOpenPublish,
  onOpenSpecAgent,
  onOpenDbAgent,
  onOpenArchitectureAgent,
  onOpenExecutionAgent,
  onOpenUxAgent,
  onOpenWireframeAgent,
}: {
  detail: AppStudioSessionDetail;
  /** Frase de ideia digitada na criação — anexada ao prompt da discovery. */
  discoveryExtra?: string | null;
  onChanged: () => void;
  onOpenPublish: () => void;
  onOpenSpecAgent?: (prompt: string) => void;
  onOpenDbAgent?: (prompt: string) => void;
  onOpenArchitectureAgent?: (prompt: string) => void;
  onOpenExecutionAgent?: (kind: 'design' | 'backend' | 'review', prompt: string) => void;
  onOpenUxAgent?: (prompt: string) => void;
  onOpenWireframeAgent?: (prompt: string) => void;
}) {
  const { t } = useTranslation('appStudio');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repairOpen, setRepairOpen] = useState(false);
  const { pipeline, session, project } = detail;

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!pipeline) {
    return (
      <div className="space-y-3 p-4 text-sm">
        <p className="text-muted-foreground">{t('pipeline.notInitialized')}</p>
        {error && <p className="text-xs text-red-600">{error}</p>}
        <Button size="sm" disabled={busy} onClick={() => void run(() => initAppPipeline(session.id))}>
          {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-1 h-3.5 w-3.5" />}
          {t('pipeline.init')}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setRepairOpen(true)}>
          <Wrench className="mr-1 h-3.5 w-3.5" /> {t('pipeline.repairAction')}
        </Button>
        <JourneyRepairDialog
          sessionId={session.id}
          open={repairOpen}
          onOpenChange={setRepairOpen}
          onRepaired={onChanged}
        />
      </div>
    );
  }

  const currentIndex = pipeline.stages.findIndex((s) => s.id === pipeline.current_stage);
  const tierProgress = (tier: AppRoadmapTier): string | null => {
    const items = pipeline.roadmap.filter((r) => r.tier === tier);
    if (items.length === 0) return null;
    return `${items.filter((r) => r.recorded).length}/${items.length}`;
  };
  const reviewGroup = detail.wireframe?.plan.build_groups.find((group) => detail.build_groups.find((state) => state.group_id === group.id)?.status === 'review');
  const designProgress = detail.wireframe
    ? `${t('experience.flowCount', { done: detail.build_groups.filter((group) => group.status === 'approved').length, total: detail.wireframe.plan.build_groups.length })} · ${t('experience.taskCount', { done: detail.build_tasks.filter((task) => task.status === 'done').length, total: detail.wireframe.plan.tasks.length })}${reviewGroup ? ` · ${t('experience.groupWaiting', { name: reviewGroup.name })}` : ''}`
    : null;

  const act = (stage: AppStageId, action: AppStageAction, feedback?: string) =>
    void run(() => patchAppStage(session.id, stage, action, feedback));

  return (
    <div className="space-y-3 p-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">{t('guide.title')}</h3>
          <p className="text-xs text-muted-foreground">
            {pipeline.current_stage
              ? t('pipeline.stageOf', { n: currentIndex + 1, total: pipeline.stages.length })
              : t('pipeline.complete')}
          </p>
        </div>
        <Button size="sm" variant="outline" className="h-7 shrink-0 px-2 text-xs" disabled={busy} onClick={() => setRepairOpen(true)}>
          <Wrench className="mr-1 h-3 w-3" /> {t('pipeline.repairAction')}
        </Button>
      </div>
      {error && <p className="rounded border border-red-300 bg-red-50 p-2 text-xs text-red-800">{error}</p>}

      {/* O PLANO para revisar — quando a entrevista terminou e a spec
          aguarda aprovação, o resumo legível fica acima da timeline. */}
      {detail.spec && pipeline.stages.find((s) => s.id === 'discovery')?.status === 'review' && (
        <SpecPanel
          spec={detail.spec}
          busy={busy}
          onApprove={() => act('discovery', 'approve')}
          onReopen={(feedback) => act('discovery', 'reopen', feedback)}
        />
      )}

      <div>
        {pipeline.stages.map((stage, index) => {
          const tier = STAGE_TIER[stage.id];
          return (
            <JourneyStepRow
              key={stage.id}
              stage={stage}
              index={index}
              isLast={index === pipeline.stages.length - 1}
              isCurrent={pipeline.current_stage === stage.id}
              progressLabel={stage.id === 'design' ? designProgress : tier ? tierProgress(tier) : null}
              busy={busy}
              onAction={(action, feedback) => act(stage.id, action, feedback)}
              onRecheck={() => void run(() => recheckAppStage(session.id, stage.id))}
              onStart={() => {
                if (!project || !isPromptableStage(stage.id)) return;
                const specialist = specialistForStage(stage.id);
                const openSpecialist = specialist === 'spec'
                  ? onOpenSpecAgent
                  : specialist === 'db'
                    ? onOpenDbAgent
                    : specialist === 'architecture'
                      ? onOpenArchitectureAgent
                      : specialist === 'ux'
                        ? onOpenUxAgent
                        : specialist === 'wireframe'
                          ? onOpenWireframeAgent
                      : (specialist === 'design' || specialist === 'backend' || specialist === 'review') && onOpenExecutionAgent
                        ? (prompt: string) => onOpenExecutionAgent(specialist, prompt)
                      : null;
                if (openSpecialist) {
                  void run(async () => {
                    await activateAppStage(session.id, stage.id);
                    openSpecialist(stagePrompt(t, stage.id, stage.id === 'discovery' ? discoveryExtra : null));
                  });
                  return;
                }
                void run(() =>
                  startAppStage(t, {
                    sessionId: session.id,
                    projectId: project.id,
                    stage: stage.id,
                    extra: stage.id === 'discovery' ? discoveryExtra : null,
                  }),
                );
              }}
              onOpenPublish={onOpenPublish}
            />
          );
        })}
      </div>
      <JourneyRepairDialog
        sessionId={session.id}
        open={repairOpen}
        onOpenChange={setRepairOpen}
        onRepaired={onChanged}
      />
    </div>
  );
}
