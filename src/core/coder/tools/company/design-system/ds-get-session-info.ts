/**
 * Tool: `ds_get_session_info`. Read-only accessor that returns the
 * Design System session config (stack, package_name, source zip path,
 * latest published version, current draft) so the master / subordinates
 * know what to build without re-querying the dashboard.
 */
import type { CoderTool, JsonSchema } from '../../../core/tool.js';
import { ok, err } from '../../../core/tool.js';
import type { CompanyOrchestrator } from '../../../company/orchestrator.js';
import { getDesignSystemStore } from './store-binding.js';

const PARAMETERS: JsonSchema = {
  type: 'object',
  properties: {},
};

export function dsGetSessionInfo(
  orchestrator: CompanyOrchestrator,
  agentRole: string,
  agentRunId: number | null,
): CoderTool {
  return {
    name: 'ds_get_session_info',
    description:
      'Read the Design System session config: stack, package_name, source zip path, current draft and last published version. Call this at the start of every task to stay in sync.',
    parameters: PARAMETERS,
    source: 'native',
    handler: async () => {
      try {
        const store = getDesignSystemStore();
        if (!store) return err('ds_get_session_info: DesignSystemStore not wired.');
        const session = store.getSessionByCompanySessionId(orchestrator.companySessionId);
        if (!session) {
          return err(
            `No DesignSystemSession bound to company_session_id=${orchestrator.companySessionId}.`,
          );
        }
        const draft = store.getLatestVersionAny(session.id);
        const published = store.getLatestPublishedVersion(session.id);
        const componentCount = draft ? store.listComponents(draft.id).length : 0;
        void agentRole; void agentRunId;
        const lines = [
          `name: ${session.name}`,
          `package_name: ${session.package_name}`,
          `stack: ${session.stack}`,
          `source_zip_path: ${session.source_zip_path ?? '(none)'}`,
          `next_bump_hint: ${session.next_bump_hint}`,
          `last_published: ${published ? `${published.semver} (${published.published_at ?? 'n/a'})` : '(none)'}`,
          `current_draft: ${draft ? `${draft.semver} status=${draft.status} components=${componentCount}` : '(none)'}`,
        ];
        return ok(lines.join('\n'));
      } catch (e) {
        return err(`ds_get_session_info failed: ${(e as Error).message}`);
      }
    },
  };
}
