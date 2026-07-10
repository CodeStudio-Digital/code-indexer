/**
 * Tool: `app_propose_spec_revision`.
 *
 * Validates a full refined AppSpec and stores it as a draft revision attached
 * to an evolution. It never overwrites the current approved spec; the user
 * applies the change from the Versions panel.
 */
import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import type { AppToolBinding } from '@mcp/company/tools/app-studio/binding.js';
import { getAppStudioStore } from '@mcp/company/tools/app-studio/store-binding.js';
import { APP_SPEC_TOOL_SCHEMA } from '@mcp/company/tools/app-studio/app-save-spec.js';
import { prepareSpecSave } from '@mcp/app-studio/spec/save-core.js';
import { parseAppSpec } from '@mcp/app-studio/spec/types.js';
import { diffAppSpecs, impactFromSpecDiff, summarizeSpecDiff } from '@mcp/app-studio/spec/revisions.js';

const PARAMETERS: JsonSchema = {
  type: 'object',
  properties: {
    evolution_id: {
      type: 'number',
      description: 'Existing evolution id (e.g. one the user opened in the Versions panel). If omitted, a versioned change is opened automatically.',
    },
    title: { type: 'string', description: 'Short human title for the proposed revision.' },
    change_reason: { type: 'string', description: 'Why this revision exists, in plain language.' },
    spec: {
      ...APP_SPEC_TOOL_SCHEMA,
      description:
        'The COMPLETE refined AppSpec v1. Preserve valid existing screens/entities unless the user explicitly changed them.',
    },
  },
  required: ['spec'],
};

export function appProposeSpecRevision(binding: AppToolBinding): CoderTool {
  return {
    name: 'app_propose_spec_revision',
    description:
      'Create a reviewable draft spec revision for an App Studio evolution. Use this after discovery is already approved or when refining a versioned app plan. It does not apply the change.',
    parameters: PARAMETERS,
    source: 'native',
    handler: async (args) => {
      try {
        const store = getAppStudioStore();
        if (!store) return err('app_propose_spec_revision: AppStudioStore not wired.');
        const session = binding.resolveAppSession(store);
        if (!session) return err(`No AppStudioSession bound to ${binding.describeBinding()}.`);

        const prepared = prepareSpecSave(args.spec, session.pipeline_json);
        if (!prepared.ok) {
          return err(
            ['Spec revision validation failed — fix every issue and call app_propose_spec_revision again:', ...prepared.issues.map((i) => `  - ${i}`)].join('\n'),
          );
        }

        const evolution = resolveOrCreateEvolution(store, session.id, args);
        const baseRevision = evolution.base_revision_id
          ? store.getSpecRevision(evolution.base_revision_id)
          : store.ensureInitialSpecRevision(session.id);
        const diff = diffAppSpecs(parseAppSpec(baseRevision?.spec_json), prepared.spec);
        const impact = impactFromSpecDiff(diff);
        const summaryLines = summarizeSpecDiff(diff);
        const revision = store.createSpecRevision({
          app_session_id: session.id,
          status: 'draft',
          title: typeof args.title === 'string' && args.title.trim() ? args.title.trim() : evolution.title,
          summary: summaryLines.join('\n'),
          change_reason: typeof args.change_reason === 'string' ? args.change_reason.trim() || evolution.description : evolution.description,
          spec_json: prepared.specJson,
          base_revision_id: baseRevision?.id ?? null,
          diff_json: JSON.stringify(diff),
          impact_json: JSON.stringify(impact),
          created_by: 'agent',
        });
        const now = new Date().toISOString();
        const updatedEvolution = store.updateEvolution(evolution.id, {
          status: 'review',
          proposed_revision_id: revision.id,
          impact_json: JSON.stringify(impact),
          submitted_at: evolution.submitted_at ?? now,
        });
        return ok(
          JSON.stringify(
            {
              evolution: updatedEvolution,
              revision: {
                id: revision.id,
                revision_number: revision.revision_number,
                status: revision.status,
                title: revision.title,
                summary: revision.summary,
              },
              impact,
              summary: summaryLines,
              next: 'Tell the user this is ready for review in the Versoes/Mudancas panel. Do not call app_save_spec for this approved plan.',
            },
            null,
            2,
          ),
        );
      } catch (e) {
        return err(`app_propose_spec_revision failed: ${(e as Error).message}`);
      }
    },
  };
}

function resolveOrCreateEvolution(
  store: NonNullable<ReturnType<typeof getAppStudioStore>>,
  sessionId: number,
  args: Record<string, unknown>,
) {
  const id = typeof args.evolution_id === 'number' ? args.evolution_id : null;
  if (id) {
    const existing = store.getEvolution(id);
    if (!existing || existing.app_session_id !== sessionId) throw new Error(`Evolution ${id} not found.`);
    return existing;
  }
  // Idempotency: if an open, empty evolution already exists for this session
  // (created here on a prior turn, or by the UI's "Criar com agente" button),
  // REUSE it instead of spawning a duplicate. Without this, a model that
  // re-issues app_propose_spec_revision without an evolution_id multiplies
  // rows in the Versions panel.
  const open = store.findOpenEvolution(sessionId);
  if (open) return open;
  const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : 'Mudanca no plano';
  const base = store.ensureInitialSpecRevision(sessionId);
  return store.createEvolution({
    app_session_id: sessionId,
    title,
    description: typeof args.change_reason === 'string' ? args.change_reason.trim() || null : null,
    base_revision_id: base?.id ?? null,
  });
}
