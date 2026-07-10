/**
 * Tool: `app_submit_stage`. O agente entrega a etapa CORRENTE do pipeline:
 * roda o gate determinístico (async — design/backend/review spawnam
 * typecheck/build) sobre o workspace; falha → devolve as issues para o
 * agente corrigir e re-submeter; sucesso → etapa vira 'review' e um
 * `<system-reminder>` (via extraUserBlocks) manda o agente PARAR até o
 * usuário aprovar. Aprovação é exclusiva da UI — não existe tool de
 * aprovar. A etapa 'launch' é submetida pela launch chain server-side.
 */
import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import type { AppToolBinding } from '@mcp/company/tools/app-studio/binding.js';
import { getAppStudioStore } from '@mcp/company/tools/app-studio/store-binding.js';
import { resolveHostPath } from '@mcp/company/tools/design-system/ds-publish-version.js';
import {
  APP_STAGE_IDS,
  AppStageTransitionError,
  applyStageSubmit,
  parsePipelineState,
  serializePipelineState,
  type AppStageId,
} from '@mcp/app-studio/pipeline/stages.js';
import { runAppStageGate } from '@mcp/app-studio/pipeline/gates.js';
import { parseAppSpec } from '@mcp/app-studio/spec/types.js';
import { parseAppArchitecturePlan } from '@mcp/app-studio/architecture/types.js';

const PARAMETERS: JsonSchema = {
  type: 'object',
  properties: {
    stage: {
      type: 'string',
      enum: [...APP_STAGE_IDS],
      description: 'The stage being delivered — must be the CURRENT stage.',
    },
    summary: {
      type: 'string',
      description:
        "Short summary of the deliverable in the USER'S language — it is shown to a non-technical user in the stage panel.",
    },
  },
  required: ['stage', 'summary'],
};

export function appSubmitStage(binding: AppToolBinding): CoderTool {
  return {
    name: 'app_submit_stage',
    description:
      'Submit the CURRENT pipeline stage for user review. Runs the deterministic stage gate first (may run typecheck/build): on failure you get the issues to fix and must re-submit; on success the stage enters review and you STOP until the user approves it in the panel.',
    parameters: PARAMETERS,
    source: 'native',
    handler: async (args, ctx) => {
      const stage = String(args.stage ?? '') as AppStageId;
      const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
      if (!APP_STAGE_IDS.includes(stage)) {
        return err(`Invalid stage '${stage}'. Use one of: ${APP_STAGE_IDS.join(', ')}.`);
      }
      if (!summary) return err('summary is required — describe the deliverable.');
      if (stage === 'launch') {
        return err(
          "The 'launch' stage is not agent-submitted — the USER publishes from the Publicar panel " +
            '(the launch chain deploys and submits the stage). Tell the user the app is ready to publish.',
        );
      }

      try {
        const store = getAppStudioStore();
        if (!store) return err('app_submit_stage: AppStudioStore not wired.');
        const session = binding.resolveAppSession(store);
        if (!session) return err(`No AppStudioSession bound to ${binding.describeBinding()}.`);
        const state = parsePipelineState(session.pipeline_json);
        if (!state) {
          return err('No app pipeline initialized for this session — nothing to submit.');
        }

        const resolved = resolveHostPath('.', ctx);
        if (resolved.kind === 'no-bind-mount') return err(resolved.message);

        const architectureRevision = store.getLatestArchitectureRevision(session.id);
        const currentSpecRevision = store.getLatestApprovedSpecRevision(session.id);
        const gate = await runAppStageGate({
          stage,
          workspaceDir: resolved.path,
          state,
          spec: parseAppSpec(session.spec_json),
          recorded: store.listFeatures(session.id).map((f) => ({ name: f.name, kind: f.kind })),
          architecture: parseAppArchitecturePlan(architectureRevision?.architecture_json),
          currentSpecRevisionId: currentSpecRevision?.id ?? null,
        });

        let next;
        try {
          next = applyStageSubmit(state, stage, summary, gate);
        } catch (e) {
          if (e instanceof AppStageTransitionError) return err(e.message);
          throw e;
        }
        store.setPipelineJson(session.id, serializePipelineState(next));

        if (!gate.ok) {
          return err(
            [
              `Stage '${stage}' gate FAILED — fix every issue and call app_submit_stage again:`,
              ...gate.issues.map((issue) => `  - ${issue}`),
            ].join('\n'),
          );
        }
        return {
          ...ok(
            `Stage '${stage}' submitted for user review (gate passed). ` +
              'The user will approve or reopen it with feedback in the stage panel.',
          ),
          extraUserBlocks: [
            {
              type: 'text',
              text:
                `<system-reminder>Stage '${stage}' was submitted for user review. STOP: do not begin ` +
                'the next stage or further build work until the user approves it in the stage panel. ' +
                "Summarize what was delivered in the user's language and wait.</system-reminder>",
            },
          ],
        };
      } catch (e) {
        return err(`app_submit_stage failed: ${(e as Error).message}`);
      }
    },
  };
}
