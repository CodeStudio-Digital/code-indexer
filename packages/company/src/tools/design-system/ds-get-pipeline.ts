/**
 * Tool: `ds_get_pipeline`. Estado da máquina de etapas do DS Studio:
 * etapas + status, etapa corrente, itens pendentes do roadmap no tier
 * corrente e resumo do theme digest. O prompt manda chamar no início de
 * toda tarefa — é o que ancora o agente na etapa certa.
 */
import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import type { DsToolBinding } from '@mcp/company/tools/design-system/binding.js';
import { getDesignSystemStore } from '@mcp/company/tools/design-system/store-binding.js';
import {
  currentStage,
  parsePipelineState,
} from '@mcp/design-system/pipeline/stages.js';
import { roadmapProgress, type DsRoadmapTier } from '@mcp/design-system/pipeline/roadmap.js';
import { collectRecordedComponents } from '@mcp/company/tools/design-system/recorded-components.js';

const PARAMETERS: JsonSchema = { type: 'object', properties: {} };

const STAGE_TIER: Partial<Record<string, DsRoadmapTier>> = {
  primitives: 'primitive',
  composites: 'composite',
  templates: 'template',
};

export function dsGetPipeline(binding: DsToolBinding): CoderTool {
  return {
    name: 'ds_get_pipeline',
    description:
      'Get the design pipeline state: stages with status, the CURRENT stage, pending roadmap components for it, and the theme digest summary. Call this at the start of every task and work ONLY on the current stage.',
    parameters: PARAMETERS,
    source: 'native',
    handler: async () => {
      try {
        const store = getDesignSystemStore();
        if (!store) return err('ds_get_pipeline: DesignSystemStore not wired.');
        const session = await binding.resolveDsSession(store);
        if (!session) return err(`No DesignSystemSession bound to ${binding.describeBinding()}.`);
        const state = parsePipelineState(session.pipeline_json);
        if (!state) {
          return ok(
            'No design pipeline initialized for this session (pre-pipeline workspace). ' +
              'Follow the design process from the system prompt manually.',
          );
        }

        const recorded = await collectRecordedComponents(store, session.id);
        const current = currentStage(state);
        const lines: string[] = [`Mode: ${session.mode}`, ''];
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
          lines.push('Pipeline complete — every stage approved or skipped.');
        } else {
          lines.push(`CURRENT stage: ${current.id}. Finish it with ds_submit_stage({ stage: '${current.id}', summary }) and STOP until the user approves.`);
          const tier = STAGE_TIER[current.id];
          if (tier) {
            const pending = roadmapProgress(
              state.roadmap.filter((item) => item.tier === tier),
              recorded.map((c) => c.name),
            ).filter((item) => !item.recorded);
            lines.push(
              pending.length === 0
                ? `Roadmap tier '${tier}': all recorded.`
                : `Pending ${tier} components (${pending.length}): ` +
                    pending.map((p) => p.source_refs?.length ? `${p.name} (theme: ${p.source_refs[0]})` : p.name).join(', '),
            );
          }
        }
        if (state.theme_digest) {
          lines.push(
            '',
            `Theme digest: ${state.theme_digest.files} files, ${state.theme_digest.colors} colors, ` +
              `${state.theme_digest.components} component candidates — read import/_analysis/THEME.md.`,
          );
        }
        return ok(lines.join('\n'));
      } catch (e) {
        return err(`ds_get_pipeline failed: ${(e as Error).message}`);
      }
    },
  };
}
