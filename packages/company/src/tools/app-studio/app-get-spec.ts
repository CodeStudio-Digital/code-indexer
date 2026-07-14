/**
 * Tool: `app_get_spec`. A AppSpec corrente (aprovada ou em rascunho) —
 * o coordenador relê em qualquer macrofase para ancorar telas/entities/auth no que
 * o usuário aprovou.
 */
import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import type { AppToolBinding } from '@mcp/company/tools/app-studio/binding.js';
import { getAppStudioStore } from '@mcp/company/tools/app-studio/store-binding.js';
import { parseAppSpec } from '@mcp/app-studio/spec/types.js';
import { appResult, PAGE_PROPERTIES, pageItems, viewArg } from './model-output.js';

const PARAMETERS: JsonSchema = {
  type: 'object',
  properties: {
    view: {
      type: 'string',
      enum: ['summary', 'requirements', 'features', 'screens', 'database', 'behaviors', 'full'],
      description: "Projection to return. Default: 'summary'. Use 'full' only when every section is required.",
    },
    ...PAGE_PROPERTIES,
  },
  additionalProperties: false,
};

export function appGetSpec(binding: AppToolBinding): CoderTool {
  return {
    name: 'app_get_spec',
    description:
      'Get the current app spec (screens, entities, auth, design tone). Re-read it before building screens or API routes so the deliverables match what the user approved.',
    parameters: PARAMETERS,
    source: 'native',
    handler: async (args) => {
      try {
        const store = getAppStudioStore();
        if (!store) return err('app_get_spec: AppStudioStore not wired.');
        const session = binding.resolveAppSession(store);
        if (!session) return err(`No AppStudioSession bound to ${binding.describeBinding()}.`);
        const spec = parseAppSpec(session.spec_json);
        if (!spec) {
          return ok('No spec saved yet — complete the Define interview and call app_save_spec.');
        }
        const view = viewArg(args, ['summary', 'requirements', 'features', 'screens', 'database', 'behaviors', 'full'], 'summary');
        if (view === 'full') return appResult('App spec — full', spec);
        const base = {
          view,
          v: spec.v,
          summary: spec.summary,
          audience: spec.audience,
          locale: spec.locale,
          auth: spec.auth,
          design: spec.design,
          integrations: spec.integrations ?? null,
          counts: {
            features: spec.features.length,
            screens: spec.screens.length,
            entities: spec.database.entities.length,
            behaviors: spec.behaviors?.length ?? 0,
          },
        };
        if (view === 'summary') return appResult('App spec — summary', base);
        if (view === 'requirements') return appResult('App spec — requirements', { ...base, requirements: spec.requirements ?? null });
        if (view === 'features') return appResult('App spec — features', { ...base, ...pageItems(spec.features, args, (item) => item.id) });
        if (view === 'screens') return appResult('App spec — screens', { ...base, ...pageItems(spec.screens, args, (item) => item.id) });
        if (view === 'database') return appResult('App spec — database', {
          ...base,
          required: spec.database.required,
          ...pageItems(spec.database.entities, args, (item) => item.name),
        });
        return appResult('App spec — behaviors', { ...base, ...pageItems(spec.behaviors ?? [], args, (item) => item.id) });
      } catch (e) {
        return err(`app_get_spec failed: ${(e as Error).message}`);
      }
    },
  };
}
