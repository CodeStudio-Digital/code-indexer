import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { auditAppArchitecture } from '@mcp/app-studio/architecture/audit.js';
import { parseAppArchitecturePlan } from '@mcp/app-studio/architecture/types.js';
import { parseAppSpec } from '@mcp/app-studio/spec/types.js';
import { parseAppProductModel } from '@mcp/app-studio/product/types.js';
import type { AppToolBinding } from './binding.js';
import { getAppStudioStore } from './store-binding.js';
import { appResult, compactAudit, PAGE_PROPERTIES, pageItems, viewArg } from './model-output.js';

const PARAMETERS: JsonSchema = {
  type: 'object',
  properties: {
    view: { type: 'string', enum: ['summary', 'modules', 'decisions', 'risks', 'sources', 'tdd', 'full'], description: "Default: 'summary'." },
    ...PAGE_PROPERTIES,
  },
  additionalProperties: false,
};

export function appGetArchitecture(binding: AppToolBinding): CoderTool {
  return {
    name: 'app_get_architecture',
    description: 'Read the latest versioned App Studio architecture and TDD contract, including its deterministic audit.',
    parameters: PARAMETERS,
    source: 'native',
    handler: async (args) => {
      try {
        const store = getAppStudioStore();
        if (!store) return err('app_get_architecture: AppStudioStore not wired.');
        const session = binding.resolveAppSession(store);
        if (!session) return err(`No AppStudioSession bound to ${binding.describeBinding()}.`);
        const revision = store.getLatestArchitectureRevision(session.id);
        const plan = parseAppArchitecturePlan(revision?.architecture_json);
        if (!revision || !plan) return ok('No architecture plan saved yet.');
        const product = parseAppProductModel(store.getLatestApprovedProductRevision(session.id)?.product_json);
        const { architecture_json: _architectureJson, ...revisionMeta } = revision;
        const audit = auditAppArchitecture(plan, parseAppSpec(session.spec_json), product);
        const view = viewArg(args, ['summary', 'modules', 'decisions', 'risks', 'sources', 'tdd', 'full'], 'summary');
        const base = {
          view,
          revision: revisionMeta,
          summary: plan.summary,
          stack_profile_id: plan.stack_profile_id,
          counts: {
            modules: plan.modules.length,
            decisions: plan.decisions.length,
            risks: plan.risks.length,
            sources: plan.sources.length,
            tdd_cases: plan.tdd.cases.length,
          },
          audit: compactAudit(audit),
        };
        if (view === 'full') return appResult('App architecture — full', { ...base, plan, audit });
        if (view === 'modules') return appResult('App architecture — modules', { ...base, ...pageItems(plan.modules, args, (item) => item.id) });
        if (view === 'decisions') return appResult('App architecture — decisions', { ...base, ...pageItems(plan.decisions, args, (item) => item.id) });
        if (view === 'risks') return appResult('App architecture — risks', { ...base, ...pageItems(plan.risks, args, (item) => item.id) });
        if (view === 'sources') return appResult('App architecture — sources', { ...base, ...pageItems(plan.sources, args, (item) => item.url) });
        if (view === 'tdd') return appResult('App architecture — TDD', { ...base, strategy: plan.tdd.strategy, ...pageItems(plan.tdd.cases, args, (item) => item.id) });
        return appResult('App architecture — summary', {
          ...base,
          data_flow: plan.data_flow,
          security: plan.security,
          observability: plan.observability,
        });
      } catch (e) {
        return err(`app_get_architecture failed: ${(e as Error).message}`);
      }
    },
  };
}
