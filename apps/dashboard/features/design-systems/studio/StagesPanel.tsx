/**
 * Painel "Etapas" do DS Studio — a face visível do design pipeline: lista
 * das 7 etapas com status/gate/ações (aprovação é DAQUI, o agente não tem
 * tool de aprovar), progresso do roadmap por tier e card do theme digest
 * com re-análise. Sessões pré-pipeline ganham o botão de backfill (init).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, RefreshCcw, Sparkles } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';
import {
  analyzeImportDs,
  initPipeline,
  patchPipelineStage,
  type DesignSystemSessionDetail,
  type DsRoadmapTier,
  type DsStageAction,
  type DsStageId,
} from '../design-system-api.js';
import { startStage } from './stage-prompts.js';
import { StageRow } from './StageRow.js';

const STAGE_TIER: Partial<Record<DsStageId, DsRoadmapTier>> = {
  primitives: 'primitive',
  composites: 'composite',
  templates: 'template',
};

export function StagesPanel({
  detail,
  onChanged,
}: {
  detail: DesignSystemSessionDetail;
  onChanged: () => void;
}) {
  const { t } = useTranslation('designSystems');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
        <Button size="sm" disabled={busy} onClick={() => void run(() => initPipeline(session.id))}>
          {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-1 h-3.5 w-3.5" />}
          {t('pipeline.init')}
        </Button>
      </div>
    );
  }

  const tierProgress = (tier: DsRoadmapTier): string | null => {
    const items = pipeline.roadmap.filter((r) => r.tier === tier);
    if (items.length === 0) return null;
    return `${items.filter((r) => r.recorded).length}/${items.length}`;
  };

  const act = (stage: DsStageId, action: DsStageAction, feedback?: string) =>
    void run(() => patchPipelineStage(session.id, stage, action, feedback));

  return (
    <div className="space-y-2 p-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{t('tabs.stages')}</h3>
        <span className="text-xs text-muted-foreground">{t(`mode.${session.mode}`)}</span>
      </div>
      {error && <p className="rounded border border-red-300 bg-red-50 p-2 text-xs text-red-800">{error}</p>}

      {pipeline.stages.map((stage, index) => {
        const tier = STAGE_TIER[stage.id];
        return (
          <StageRow
            key={stage.id}
            stage={stage}
            index={index}
            isCurrent={pipeline.current_stage === stage.id}
            progressLabel={tier ? tierProgress(tier) : null}
            onAction={(action, feedback) => act(stage.id, action, feedback)}
            onStart={() => {
              if (!project) return;
              void run(() => startStage(t, { dsSessionId: session.id, projectId: project.id, stage: stage.id }));
            }}
          />
        );
      })}

      <div className="rounded border bg-muted/20 px-2.5 py-2 text-xs">
        {pipeline.theme_digest ? (
          <p className="text-muted-foreground">
            {t('pipeline.digestSummary', {
              files: pipeline.theme_digest.files,
              colors: pipeline.theme_digest.colors,
              components: pipeline.theme_digest.components,
            })}
          </p>
        ) : (
          <p className="text-muted-foreground">{t('pipeline.noDigest')}</p>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="mt-1 h-6 px-1.5 text-xs"
          disabled={busy}
          onClick={() => void run(() => analyzeImportDs(session.id))}
        >
          <RefreshCcw className="mr-1 h-3 w-3" /> {t('pipeline.reanalyze')}
        </Button>
      </div>
    </div>
  );
}
