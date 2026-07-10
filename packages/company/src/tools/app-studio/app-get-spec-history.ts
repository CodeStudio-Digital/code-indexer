/**
 * Tool: `app_get_spec_history`.
 *
 * Returns the App Studio spec timeline: approved revisions, proposed drafts
 * and user-facing evolutions. The output omits raw `spec_json` to stay compact;
 * agents can call `app_get_spec` for the current full spec.
 */
import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import type { AppToolBinding } from '@mcp/company/tools/app-studio/binding.js';
import { getAppStudioStore } from '@mcp/company/tools/app-studio/store-binding.js';
import { parseAppSpec } from '@mcp/app-studio/spec/types.js';
import type { AppStudioSpecRevision } from '@mcp/store/app-studio-store.js';

const PARAMETERS: JsonSchema = { type: 'object', properties: {} };

export function appGetSpecHistory(binding: AppToolBinding): CoderTool {
  return {
    name: 'app_get_spec_history',
    description:
      'List App Studio spec revisions and product evolutions. Use this before refining an already-approved app plan so you know the current approved version and open change requests.',
    parameters: PARAMETERS,
    source: 'native',
    handler: async () => {
      try {
        const store = getAppStudioStore();
        if (!store) return err('app_get_spec_history: AppStudioStore not wired.');
        const session = binding.resolveAppSession(store);
        if (!session) return err(`No AppStudioSession bound to ${binding.describeBinding()}.`);
        const current = store.ensureInitialSpecRevision(session.id);
        const revisions = store.listSpecRevisions(session.id).map(revisionSummary);
        const evolutions = store.listEvolutions(session.id).map((e) => ({
          id: e.id,
          title: e.title,
          description: e.description,
          status: e.status,
          base_revision_id: e.base_revision_id,
          proposed_revision_id: e.proposed_revision_id,
          impact: parseJson(e.impact_json),
          created_at: e.created_at,
          submitted_at: e.submitted_at,
          applied_at: e.applied_at,
        }));
        return ok(JSON.stringify({ current_revision_id: current?.id ?? null, revisions, evolutions }, null, 2));
      } catch (e) {
        return err(`app_get_spec_history failed: ${(e as Error).message}`);
      }
    },
  };
}

function revisionSummary(revision: AppStudioSpecRevision) {
  const spec = parseAppSpec(revision.spec_json);
  return {
    id: revision.id,
    revision_number: revision.revision_number,
    status: revision.status,
    title: revision.title,
    summary: revision.summary,
    change_reason: revision.change_reason,
    base_revision_id: revision.base_revision_id,
    impact: parseJson(revision.impact_json),
    spec_summary: spec
      ? {
          summary: spec.summary,
          screens: spec.screens.length,
          entities: spec.database.entities.length,
          features: spec.features.length,
          behaviors: spec.behaviors?.length ?? 0,
        }
      : null,
    created_at: revision.created_at,
    approved_at: revision.approved_at,
  };
}

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}
