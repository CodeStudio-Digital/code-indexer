import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { err } from '@mcp/code-agent/core/tool.js';
import { replaceAppSeedFile, validateAppSeedSql } from '@mcp/app-studio/database/seed.js';
import { parseAppWorkflowState } from '@mcp/app-studio/workflow/state.js';
import { resolveHostPath } from '@mcp/company/tools/design-system/ds-publish-version.js';
import type { AppToolBinding } from './binding.js';
import { getAppStudioStore } from './store-binding.js';
import { appResult } from './model-output.js';

const PARAMETERS: JsonSchema = {
  type: 'object',
  properties: {
    sql: { type: 'string', description: 'COMPLETE canonical preview seed. Every statement must use INSERT OR IGNORE or ON CONFLICT.' },
    reason: { type: 'string', description: 'Short explanation of why the example data changed.' },
  },
  required: ['sql', 'reason'],
  additionalProperties: false,
};

export function appSaveDbSeed(binding: AppToolBinding): CoderTool {
  return {
    name: 'app_save_db_seed',
    description: 'Safely replace the complete canonical local preview seed with validation and an automatic backup. Use this for example-data changes or seed failures; never create a migration just to edit examples.',
    parameters: PARAMETERS,
    source: 'native',
    riskLevel: 'write',
    handler: async (args, ctx) => {
      try {
        const sql = typeof args.sql === 'string' ? args.sql : '';
        const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
        if (!reason) return err('reason is required.');
        const issue = validateAppSeedSql(sql);
        if (issue) return err(`app_save_db_seed: ${issue}`);
        const store = getAppStudioStore();
        if (!store) return err('app_save_db_seed: AppStudioStore not wired.');
        const session = binding.resolveAppSession(store);
        if (!session) return err(`No AppStudioSession bound to ${binding.describeBinding()}.`);
        const state = parseAppWorkflowState(session.pipeline_json);
        const blueprint = state?.phases.find((phase) => phase.id === 'blueprint');
        const build = state?.phases.find((phase) => phase.id === 'build');
        if (!state || (blueprint?.status !== 'active' && blueprint?.status !== 'attention' && build?.status !== 'active')) {
          return err('Canonical seed changes are available only inside an active Blueprint or Build card.');
        }
        const resolved = resolveHostPath('.', ctx);
        if (resolved.kind === 'no-bind-mount') return err(resolved.message);
        const result = replaceAppSeedFile(resolved.path, sql);
        return appResult('App database seed saved', {
          changed: result.changed,
          seed_path: 'seeds/seed.sql',
          backup_path: result.backup_path,
          hash: result.hash,
          reason,
          next: result.changed
            ? 'Run app_provision_db once, then verify with db_schema and read-only db_query.'
            : 'The canonical seed is unchanged. Do not create a migration; inspect the actual database state.',
        });
      } catch (e) {
        return err(`app_save_db_seed failed: ${(e as Error).message}`);
      }
    },
  };
}
