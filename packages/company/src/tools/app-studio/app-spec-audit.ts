/**
 * Tool: `app_spec_audit`. Deterministic quality check for App Studio specs.
 * It gives the coordinator a compact, tool-readable list of weak spots
 * before it asks the user or saves a refined spec.
 */
import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import type { AppToolBinding } from '@mcp/company/tools/app-studio/binding.js';
import { getAppStudioStore } from '@mcp/company/tools/app-studio/store-binding.js';
import { parseAppSpec } from '@mcp/app-studio/spec/types.js';
import { auditAppSpec } from '@mcp/app-studio/spec/audit.js';
import { appResult } from './model-output.js';

const PARAMETERS: JsonSchema = { type: 'object', properties: {} };

export function appSpecAudit(binding: AppToolBinding): CoderTool {
  return {
    name: 'app_spec_audit',
    description:
      'Audit the current App Studio spec for weak requirements, missing acceptance criteria, unlinked screens/features, FK/reference gaps, auth gaps, and missing flow actions. Read-only.',
    parameters: PARAMETERS,
    source: 'native',
    handler: async () => {
      try {
        const store = getAppStudioStore();
        if (!store) return err('app_spec_audit: AppStudioStore not wired.');
        const session = binding.resolveAppSession(store);
        if (!session) return err(`No AppStudioSession bound to ${binding.describeBinding()}.`);
        const spec = parseAppSpec(session.spec_json);
        if (!spec) return ok('No spec saved yet — complete Define and call app_save_spec first.');
        const report = auditAppSpec(spec);
        const topIssues = report.issues.slice(0, 12);
        return appResult('App spec audit', { ...report, issues: topIssues });
      } catch (e) {
        return err(`app_spec_audit failed: ${(e as Error).message}`);
      }
    },
  };
}
