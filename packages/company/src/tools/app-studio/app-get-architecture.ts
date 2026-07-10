import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { auditAppArchitecture } from '@mcp/app-studio/architecture/audit.js';
import { parseAppArchitecturePlan } from '@mcp/app-studio/architecture/types.js';
import { parseAppSpec } from '@mcp/app-studio/spec/types.js';
import type { AppToolBinding } from './binding.js';
import { getAppStudioStore } from './store-binding.js';

const PARAMETERS: JsonSchema = { type: 'object', properties: {} };

export function appGetArchitecture(binding: AppToolBinding): CoderTool {
  return {
    name: 'app_get_architecture',
    description: 'Read the latest versioned App Studio architecture and TDD contract, including its deterministic audit.',
    parameters: PARAMETERS,
    source: 'native',
    handler: async () => {
      try {
        const store = getAppStudioStore();
        if (!store) return err('app_get_architecture: AppStudioStore not wired.');
        const session = binding.resolveAppSession(store);
        if (!session) return err(`No AppStudioSession bound to ${binding.describeBinding()}.`);
        const revision = store.getLatestArchitectureRevision(session.id);
        const plan = parseAppArchitecturePlan(revision?.architecture_json);
        if (!revision || !plan) return ok('No architecture plan saved yet.');
        return ok(JSON.stringify({ revision: { ...revision, architecture_json: undefined }, plan, audit: auditAppArchitecture(plan, parseAppSpec(session.spec_json)) }, null, 2));
      } catch (e) {
        return err(`app_get_architecture failed: ${(e as Error).message}`);
      }
    },
  };
}
