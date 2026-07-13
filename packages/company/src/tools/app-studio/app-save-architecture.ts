import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { err } from '@mcp/code-agent/core/tool.js';
import { resolveHostPath } from '@mcp/company/tools/design-system/ds-publish-version.js';
import { auditAppArchitecture } from '@mcp/app-studio/architecture/audit.js';
import {
  normalizeAppArchitecturePlan,
  serializeAppArchitecturePlan,
} from '@mcp/app-studio/architecture/types.js';
import { parsePipelineState } from '@mcp/app-studio/pipeline/stages.js';
import { parseAppSpec } from '@mcp/app-studio/spec/types.js';
import { parseAppProductModel } from '@mcp/app-studio/product/types.js';
import type { AppToolBinding } from './binding.js';
import { appResult } from './model-output.js';
import { getAppStudioStore } from './store-binding.js';

const PARAMETERS: JsonSchema = {
  type: 'object',
  properties: {
    plan: {
      type: 'object',
      description: 'Complete AppArchitecturePlan v1, including modules, decisions, official sources and tdd cases.',
      properties: {
        summary: { type: 'string' },
        modules: { type: 'array', items: { type: 'object', properties: {
          id: { type: 'string' }, name: { type: 'string' }, layer: { type: 'string', enum: ['ui', 'worker', 'data', 'cross-cutting'] },
          responsibility: { type: 'string' }, depends_on: { type: 'array', items: { type: 'string' } },
        }, required: ['id', 'name', 'layer', 'responsibility'] } },
        decisions: { type: 'array', items: { type: 'object', properties: {
          id: { type: 'string' }, title: { type: 'string' }, decision: { type: 'string' }, rationale: { type: 'string' },
          source_urls: { type: 'array', items: { type: 'string' } },
        }, required: ['id', 'title', 'decision', 'rationale'] } },
        data_flow: { type: 'array', items: { type: 'string' } },
        security: { type: 'array', items: { type: 'string' } },
        observability: { type: 'array', items: { type: 'string' } },
        risks: { type: 'array', items: { type: 'object', properties: {
          id: { type: 'string' }, title: { type: 'string' }, mitigation: { type: 'string' }, severity: { type: 'string', enum: ['low', 'medium', 'high'] },
        }, required: ['id', 'title', 'mitigation', 'severity'] } },
        sources: { type: 'array', items: { type: 'object', properties: {
          title: { type: 'string' }, url: { type: 'string' }, checked_at: { type: 'string' }, notes: { type: 'string' },
        }, required: ['title', 'url', 'checked_at', 'notes'] } },
        tdd: { type: 'object', properties: {
          strategy: { type: 'string' },
          cases: { type: 'array', items: { type: 'object', properties: {
            id: { type: 'string' }, title: { type: 'string' }, layer: { type: 'string', enum: ['database', 'worker', 'browser', 'e2e'] },
            owner_stage: { type: 'string', enum: ['database', 'design', 'backend', 'review'] },
            priority: { type: 'string', enum: ['critical', 'important', 'supporting'] },
            source_ids: { type: 'array', items: { type: 'string' } }, preconditions: { type: 'array', items: { type: 'string' } },
            steps: { type: 'array', items: { type: 'string' } }, expected: { type: 'string' },
          }, required: ['id', 'title', 'layer', 'owner_stage', 'priority', 'source_ids', 'steps', 'expected'] } },
        }, required: ['strategy', 'cases'] },
      },
      required: ['summary', 'modules', 'decisions', 'sources', 'tdd'],
      additionalProperties: false,
    },
  },
  required: ['plan'],
};

export function appSaveArchitecture(binding: AppToolBinding): CoderTool {
  return {
    name: 'app_save_architecture',
    description: 'Validate and save a versioned architecture plus TDD contract for the current approved spec. Repeated calls update the current draft.',
    parameters: PARAMETERS,
    source: 'native',
    handler: async (args, ctx) => {
      try {
        const store = getAppStudioStore();
        if (!store) return err('app_save_architecture: AppStudioStore not wired.');
        const session = binding.resolveAppSession(store);
        if (!session) return err(`No AppStudioSession bound to ${binding.describeBinding()}.`);
        const spec = parseAppSpec(session.spec_json);
        if (!spec) return err('No approved app spec found. Finish discovery first.');
        const state = parsePipelineState(session.pipeline_json);
        const discovery = state?.stages.find((stage) => stage.id === 'discovery');
        if (discovery?.status !== 'approved') return err('Discovery is not approved. Finish and approve the app plan before architecture.');
        const pendingSpecRevision = store.getPendingSpecRevision(session.id);
        if (pendingSpecRevision) {
          return err(
            `Spec revision v${pendingSpecRevision.revision_number} is waiting for user review. ` +
              'Do not save architecture against the previous spec. Ask the user to approve or reject the revision in Versions/Changes first.',
          );
        }
        const specRevision = store.getLatestApprovedSpecRevision(session.id) ?? store.ensureInitialSpecRevision(session.id);
        if (!specRevision) return err('No approved spec revision found. Approve discovery first.');
        const raw = args.plan && typeof args.plan === 'object' ? args.plan as Record<string, unknown> : {};
        const plan = normalizeAppArchitecturePlan(raw, specRevision.id);
        const product = parseAppProductModel(store.getLatestApprovedProductRevision(session.id)?.product_json);
        const audit = auditAppArchitecture(plan, spec, product);
        if (!audit.ok) {
          return err(['Architecture audit failed:', ...audit.issues.map((issue) => `  - ${issue}`)].join('\n'));
        }
        const json = serializeAppArchitecturePlan(plan);
        const revision = store.saveArchitectureRevision({
          app_session_id: session.id,
          spec_revision_id: specRevision.id,
          architecture_json: json,
          created_by: 'agent',
        });
        const resolved = resolveHostPath('.', ctx);
        if (resolved.kind !== 'no-bind-mount') {
          const target = join(resolved.path, 'spec', 'app-architecture.json');
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, json, 'utf8');
        }
        return appResult('App architecture saved', { revision: { id: revision.id, revision_number: revision.revision_number, status: revision.status }, audit, next: "Submit with app_submit_stage({ stage: 'architecture', summary }) when the user-facing plan is ready." });
      } catch (e) {
        return err(`app_save_architecture failed: ${(e as Error).message}`);
      }
    },
  };
}
