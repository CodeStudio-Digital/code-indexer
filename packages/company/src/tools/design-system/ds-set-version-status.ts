/**
 * Tool: `ds_set_version_status`. Master uses this to flip the current
 * draft into 'failed' when a build round goes irrecoverable. The
 * happy-path 'published' transition is owned by `ds_publish_version`
 * (so we never have two separate code paths writing the published
 * status).
 */
import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import type { DsToolBinding } from '@mcp/company/tools/design-system/binding.js';
import { getDesignSystemStore } from '@mcp/company/tools/design-system/store-binding.js';

const PARAMETERS: JsonSchema = {
  type: 'object',
  properties: {
    status: {
      type: 'string',
      enum: ['failed'],
      description: "Only 'failed' is allowed here — 'published' is set by ds_publish_version.",
    },
    error: {
      type: 'string',
      description: 'Short human-readable explanation of why the build failed.',
    },
  },
  required: ['status'],
};

export function dsSetVersionStatus(binding: DsToolBinding): CoderTool {
  return {
    name: 'ds_set_version_status',
    description:
      "Mark the active draft version as 'failed' (with an error message). Use only when the build can't proceed and operator intervention is needed.",
    parameters: PARAMETERS,
    source: 'native',
    handler: async (args) => {
      try {
        const store = getDesignSystemStore();
        if (!store) return err('ds_set_version_status: DesignSystemStore not wired.');
        const session = await binding.resolveDsSession(store);
        if (!session) return err(`No DesignSystemSession bound to ${binding.describeBinding()}.`);
        const draft = await store.getLatestVersionAny(session.id);
        if (!draft || (draft.status !== 'draft' && draft.status !== 'building')) {
          return err('No active draft version to update.');
        }
        const status = args.status;
        if (status !== 'failed') {
          return err(`status='${status}' not allowed via this tool. Use ds_publish_version for 'published'.`);
        }
        const error = typeof args.error === 'string' ? args.error : null;
        const updated = await store.updateVersion(draft.id, { status: 'failed', error });
        return ok(`Marked draft v${updated.semver} as failed${error ? ` — ${error}` : ''}.`);
      } catch (e) {
        return err(`ds_set_version_status failed: ${(e as Error).message}`);
      }
    },
  };
}
