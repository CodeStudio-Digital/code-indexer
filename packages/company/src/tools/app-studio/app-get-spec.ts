/**
 * Tool: `app_get_spec`. A AppSpec corrente (aprovada ou em rascunho) —
 * o agente relê em qualquer etapa para ancorar telas/entities/auth no que
 * o usuário aprovou.
 */
import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import type { AppToolBinding } from '@mcp/company/tools/app-studio/binding.js';
import { getAppStudioStore } from '@mcp/company/tools/app-studio/store-binding.js';
import { parseAppSpec, serializeAppSpec } from '@mcp/app-studio/spec/types.js';

const PARAMETERS: JsonSchema = { type: 'object', properties: {} };

export function appGetSpec(binding: AppToolBinding): CoderTool {
  return {
    name: 'app_get_spec',
    description:
      'Get the current app spec (screens, entities, auth, design tone). Re-read it before building screens or API routes so the deliverables match what the user approved.',
    parameters: PARAMETERS,
    source: 'native',
    handler: async () => {
      try {
        const store = getAppStudioStore();
        if (!store) return err('app_get_spec: AppStudioStore not wired.');
        const session = binding.resolveAppSession(store);
        if (!session) return err(`No AppStudioSession bound to ${binding.describeBinding()}.`);
        const spec = parseAppSpec(session.spec_json);
        if (!spec) {
          return ok('No spec saved yet — run the interview (discovery stage) and call app_save_spec.');
        }
        return ok(serializeAppSpec(spec));
      } catch (e) {
        return err(`app_get_spec failed: ${(e as Error).message}`);
      }
    },
  };
}
