/**
 * Tool: `app_get_pipeline`. Estado da máquina de etapas do App Studio:
 * etapas + status, etapa corrente, pendências do roadmap e resumo da spec.
 * O prompt manda chamar no início de toda tarefa — é o que ancora o agente
 * na etapa certa.
 */
import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import type { AppToolBinding } from '@mcp/company/tools/app-studio/binding.js';
import { getAppStudioStore } from '@mcp/company/tools/app-studio/store-binding.js';
import { currentStage, parsePipelineState } from '@mcp/app-studio/pipeline/stages.js';
import { roadmapProgress, type AppRoadmapTier } from '@mcp/app-studio/pipeline/roadmap.js';
import { parseAppSpec } from '@mcp/app-studio/spec/types.js';

const PARAMETERS: JsonSchema = { type: 'object', properties: {} };

const STAGE_TIER: Partial<Record<string, AppRoadmapTier>> = {
  design: 'screen',
  backend: 'api',
};

export function appGetPipeline(binding: AppToolBinding): CoderTool {
  return {
    name: 'app_get_pipeline',
    description:
      'Get the app pipeline state: stages with status, the CURRENT stage, pending roadmap items for it, and the approved spec summary. Call this at the start of every task and work ONLY on the current stage.',
    parameters: PARAMETERS,
    source: 'native',
    handler: async () => {
      try {
        const store = getAppStudioStore();
        if (!store) return err('app_get_pipeline: AppStudioStore not wired.');
        const session = binding.resolveAppSession(store);
        if (!session) return err(`No AppStudioSession bound to ${binding.describeBinding()}.`);
        const state = parsePipelineState(session.pipeline_json);
        if (!state) {
          return ok('No app pipeline initialized for this session — ask the user to run pipeline init from the panel.');
        }

        const spec = parseAppSpec(session.spec_json);
        const recorded = store.listFeatures(session.id).map((f) => ({ name: f.name, kind: f.kind }));
        const current = currentStage(state);
        const lines: string[] = [`App: ${session.name} (worker '${session.app_slug}', db ${session.db_engine})`, ''];
        for (const stage of state.stages) {
          const marker = current?.id === stage.id ? '→' : ' ';
          const extra = [
            stage.summary ? `summary: ${stage.summary}` : null,
            stage.feedback ? `user feedback: ${stage.feedback}` : null,
            stage.gate && !stage.gate.ok ? `gate issues: ${stage.gate.issues.length}` : null,
          ].filter(Boolean).join(' · ');
          lines.push(`${marker} ${stage.id} [${stage.status}]${extra ? ` — ${extra}` : ''}`);
        }
        lines.push('');
        if (!current) {
          lines.push('Pipeline complete — every stage approved or skipped. The app is live.');
        } else {
          lines.push(
            `CURRENT stage: ${current.id}. Finish it with app_submit_stage({ stage: '${current.id}', summary }) and STOP until the user approves.`,
          );
          const tier = STAGE_TIER[current.id];
          if (tier) {
            const pending = roadmapProgress(
              state.roadmap.filter((item) => item.tier === tier),
              recorded,
            ).filter((item) => !item.recorded);
            lines.push(
              pending.length === 0
                ? `Roadmap tier '${tier}': all recorded.`
                : `Pending ${tier} deliverables (${pending.length}): ${pending.map((p) => p.name).join(', ')}.`,
            );
          }
        }
        if (spec) {
          lines.push(
            '',
            `Spec: "${spec.summary}" — ${spec.screens.length} screen(s), ` +
              `${spec.database.required ? `${spec.database.entities.length} entity(ies)` : 'no database'}, ` +
              `auth ${spec.auth.enabled ? 'ON' : 'off'}, user language ${spec.locale}. Full spec: app_get_spec.`,
          );
        } else {
          lines.push('', 'No spec saved yet — run the interview and app_save_spec (discovery stage).');
        }
        return ok(lines.join('\n'));
      } catch (e) {
        return err(`app_get_pipeline failed: ${(e as Error).message}`);
      }
    },
  };
}
