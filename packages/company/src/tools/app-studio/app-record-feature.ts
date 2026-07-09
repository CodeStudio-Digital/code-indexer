/**
 * Tool: `app_record_feature`. Registra um deliverable pronto (tela, API ou
 * feature transversal) — a cobertura do roadmap deriva destes registros
 * (name-match tier-aware) e os gates de design/backend cobram. Upsert no
 * UNIQUE(session, name, kind): re-registrar atualiza summary/verificação.
 */
import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import type { AppToolBinding } from '@mcp/company/tools/app-studio/binding.js';
import { getAppStudioStore } from '@mcp/company/tools/app-studio/store-binding.js';
import type { AppStudioFeatureKind } from '@mcp/store/app-studio-store.js';

const KINDS: AppStudioFeatureKind[] = ['screen', 'api', 'feature'];

const PARAMETERS: JsonSchema = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      description:
        "The deliverable's code name — screen component name (e.g. 'PainelScreen') for kind 'screen'; entity name (e.g. 'pedidos') for kind 'api'.",
    },
    kind: { type: 'string', enum: [...KINDS], description: "'screen' | 'api' | 'feature'." },
    summary: { type: 'string', description: 'One line: what it does (user language ok).' },
    verified_in_preview: {
      type: 'boolean',
      description: 'true only after you actually exercised it in the live preview (screenshot/click).',
    },
  },
  required: ['name', 'kind'],
};

export function appRecordFeature(binding: AppToolBinding): CoderTool {
  return {
    name: 'app_record_feature',
    description:
      'Record a finished deliverable (screen/api/feature). Roadmap coverage derives from these records — the design and backend gates require them. Record ONLY after verifying the deliverable works in the preview.',
    parameters: PARAMETERS,
    source: 'native',
    handler: async (args) => {
      try {
        const name = typeof args.name === 'string' ? args.name.trim() : '';
        const kind = String(args.kind ?? '') as AppStudioFeatureKind;
        if (!name) return err('name is required.');
        if (!KINDS.includes(kind)) return err(`Invalid kind '${kind}'. Use screen, api or feature.`);

        const store = getAppStudioStore();
        if (!store) return err('app_record_feature: AppStudioStore not wired.');
        const session = binding.resolveAppSession(store);
        if (!session) return err(`No AppStudioSession bound to ${binding.describeBinding()}.`);

        const feature = store.upsertFeature({
          app_session_id: session.id,
          name,
          kind,
          summary: typeof args.summary === 'string' ? args.summary.trim() : null,
          verified_in_preview: args.verified_in_preview === true,
        });
        return ok(
          `Recorded ${feature.kind} '${feature.name}'${feature.verified_in_preview ? ' (verified in preview)' : ''}.`,
        );
      } catch (e) {
        return err(`app_record_feature failed: ${(e as Error).message}`);
      }
    },
  };
}
