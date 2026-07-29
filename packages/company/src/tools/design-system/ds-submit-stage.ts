/**
 * Tool: `ds_submit_stage`. O agente entrega a etapa CORRENTE do pipeline:
 * roda o gate determinístico sobre o workspace; falha → devolve as issues
 * para o agente corrigir e re-submeter; sucesso → etapa vira 'review' e um
 * `<system-reminder>` (via extraUserBlocks, padrão do applyPlanApproval)
 * manda o agente PARAR até o usuário aprovar. Aprovação é exclusiva da UI
 * — não existe tool de aprovar.
 */
import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import type { DsToolBinding } from '@mcp/company/tools/design-system/binding.js';
import { getDesignSystemStore } from '@mcp/company/tools/design-system/store-binding.js';
import { resolveHostPath } from '@mcp/company/tools/design-system/ds-publish-version.js';
import { collectRecordedComponents } from '@mcp/company/tools/design-system/recorded-components.js';
import {
  DS_STAGE_IDS,
  DsStageTransitionError,
  applyStageSubmit,
  parsePipelineState,
  serializePipelineState,
  type DsStageId,
} from '@mcp/design-system/pipeline/stages.js';
import { runStageGate } from '@mcp/design-system/pipeline/gates.js';

const PARAMETERS: JsonSchema = {
  type: 'object',
  properties: {
    stage: {
      type: 'string',
      enum: [...DS_STAGE_IDS],
      description: 'The stage being delivered — must be the CURRENT stage.',
    },
    summary: {
      type: 'string',
      description: 'Short summary of the deliverable (what was built/changed), shown to the user in the stage panel.',
    },
  },
  required: ['stage', 'summary'],
};

export function dsSubmitStage(binding: DsToolBinding): CoderTool {
  return {
    name: 'ds_submit_stage',
    description:
      'Submit the CURRENT pipeline stage for user review. Runs the deterministic stage gate first: on failure you get the issues to fix and must re-submit; on success the stage enters review and you STOP until the user approves it in the UI.',
    parameters: PARAMETERS,
    source: 'native',
    handler: async (args, ctx) => {
      const stage = String(args.stage ?? '') as DsStageId;
      const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
      if (!DS_STAGE_IDS.includes(stage)) {
        return err(`Invalid stage '${stage}'. Use one of: ${DS_STAGE_IDS.join(', ')}.`);
      }
      if (!summary) return err('summary is required — describe the deliverable.');

      try {
        const store = getDesignSystemStore();
        if (!store) return err('ds_submit_stage: DesignSystemStore not wired.');
        const session = await binding.resolveDsSession(store);
        if (!session) return err(`No DesignSystemSession bound to ${binding.describeBinding()}.`);
        const state = parsePipelineState(session.pipeline_json);
        if (!state) {
          return err('No design pipeline initialized for this session — nothing to submit.');
        }

        const resolved = resolveHostPath('.', ctx);
        if (resolved.kind === 'no-bind-mount') return err(resolved.message);

        const gate = runStageGate({
          stage,
          mode: session.mode,
          workspaceDir: resolved.path,
          state,
          recorded: await collectRecordedComponents(store, session.id),
        });

        let next;
        try {
          next = applyStageSubmit(state, stage, summary, gate);
        } catch (e) {
          if (e instanceof DsStageTransitionError) return err(e.message);
          throw e;
        }
        await store.setPipelineJson(session.id, serializePipelineState(next));

        if (!gate.ok) {
          return err(
            [
              `Stage '${stage}' gate FAILED — fix every issue and call ds_submit_stage again:`,
              ...gate.issues.map((issue) => `  - ${issue}`),
            ].join('\n'),
          );
        }
        return {
          ...ok(
            `Stage '${stage}' submitted for user review (gate passed). ` +
              'The user will approve, reopen with feedback, or skip it in the stage panel.',
          ),
          extraUserBlocks: [
            {
              type: 'text',
              text:
                `<system-reminder>Stage '${stage}' was submitted for user review. STOP: do not begin ` +
                'the next stage or further component work until the user approves it in the stage panel. ' +
                'Summarize what was delivered and wait.</system-reminder>',
            },
          ],
        };
      } catch (e) {
        return err(`ds_submit_stage failed: ${(e as Error).message}`);
      }
    },
  };
}
