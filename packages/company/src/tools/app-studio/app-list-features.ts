/**
 * Tool: `app_list_features`. Deliverables registrados × roadmap da spec —
 * a visão de cobertura que os gates de design/backend usam.
 */
import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import type { AppToolBinding } from '@mcp/company/tools/app-studio/binding.js';
import { getAppStudioStore } from '@mcp/company/tools/app-studio/store-binding.js';
import { parsePipelineState } from '@mcp/app-studio/pipeline/stages.js';
import { roadmapProgress } from '@mcp/app-studio/pipeline/roadmap.js';

const PARAMETERS: JsonSchema = { type: 'object', properties: {} };

export function appListFeatures(binding: AppToolBinding): CoderTool {
  return {
    name: 'app_list_features',
    description:
      'List recorded deliverables and roadmap coverage (which spec screens/APIs are still missing a record).',
    parameters: PARAMETERS,
    source: 'native',
    handler: async () => {
      try {
        const store = getAppStudioStore();
        if (!store) return err('app_list_features: AppStudioStore not wired.');
        const session = binding.resolveAppSession(store);
        if (!session) return err(`No AppStudioSession bound to ${binding.describeBinding()}.`);

        const features = store.listFeatures(session.id);
        const lines: string[] = [];
        if (features.length === 0) {
          lines.push('No deliverables recorded yet.');
        } else {
          lines.push(`Recorded (${features.length}):`);
          for (const f of features) {
            lines.push(`  - [${f.kind}] ${f.name}${f.verified_in_preview ? ' ✓preview' : ''}${f.summary ? ` — ${f.summary}` : ''}`);
          }
        }
        const state = parsePipelineState(session.pipeline_json);
        if (state && state.roadmap.length > 0) {
          const progress = roadmapProgress(
            state.roadmap,
            features.map((f) => ({ name: f.name, kind: f.kind })),
          );
          const missing = progress.filter((item) => !item.recorded);
          lines.push(
            '',
            missing.length === 0
              ? 'Roadmap: fully covered.'
              : `Roadmap missing (${missing.length}): ${missing.map((m) => `${m.name} [${m.tier}]`).join(', ')}.`,
          );
        }
        return ok(lines.join('\n'));
      } catch (e) {
        return err(`app_list_features failed: ${(e as Error).message}`);
      }
    },
  };
}
