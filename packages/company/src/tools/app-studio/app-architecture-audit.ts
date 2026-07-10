import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { auditAppArchitecture } from '@mcp/app-studio/architecture/audit.js';
import { parseAppArchitecturePlan } from '@mcp/app-studio/architecture/types.js';
import { parseAppSpec } from '@mcp/app-studio/spec/types.js';
import type { AppToolBinding } from './binding.js';
import { getAppStudioStore } from './store-binding.js';

const PARAMETERS: JsonSchema = { type: 'object', properties: {} };

export function appArchitectureAudit(binding: AppToolBinding): CoderTool {
  return {
    name: 'app_architecture_audit',
    description: 'Audit architecture completeness, official sources, module dependencies and test traceability against the current app spec.',
    parameters: PARAMETERS,
    source: 'native',
    handler: async () => {
      try {
        const store = getAppStudioStore();
        if (!store) return err('app_architecture_audit: AppStudioStore not wired.');
        const session = binding.resolveAppSession(store);
        if (!session) return err(`No AppStudioSession bound to ${binding.describeBinding()}.`);
        const revision = store.getLatestArchitectureRevision(session.id);
        const report = auditAppArchitecture(parseAppArchitecturePlan(revision?.architecture_json), parseAppSpec(session.spec_json));
        return report.ok ? ok(JSON.stringify(report, null, 2)) : err(JSON.stringify(report, null, 2));
      } catch (e) {
        return err(`app_architecture_audit failed: ${(e as Error).message}`);
      }
    },
  };
}
