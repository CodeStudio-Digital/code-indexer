import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { err } from '@mcp/code-agent/core/tool.js';
import { auditAppUxBrief, auditAppWireframePlan } from '@mcp/app-studio/experience/audit.js';
import {
  dataModelFingerprint,
  normalizeAppUxBrief,
  normalizeAppWireframePlan,
  parseAppUxBrief,
  parseAppWireframePlan,
  serializeExperienceArtifact,
} from '@mcp/app-studio/experience/types.js';
import { parseAppArchitecturePlan } from '@mcp/app-studio/architecture/types.js';
import { parseAppProductModel } from '@mcp/app-studio/product/types.js';
import { currentStage, parsePipelineState } from '@mcp/app-studio/pipeline/stages.js';
import { parseAppSpec } from '@mcp/app-studio/spec/types.js';
import { resolveHostPath } from '@mcp/company/tools/design-system/ds-publish-version.js';
import type { AppToolBinding } from './binding.js';
import { getAppStudioStore } from './store-binding.js';
import { appResult, compactAudit, PAGE_PROPERTIES, pageItems, viewArg } from './model-output.js';

const EMPTY: JsonSchema = { type: 'object', properties: {}, additionalProperties: false };
const WRAPPED = (name: 'brief' | 'plan'): JsonSchema => ({
  type: 'object',
  properties: { [name]: { type: 'object', description: `Complete ${name} object following the App Studio experience contract.` } },
  required: [name],
  additionalProperties: false,
});

function context(binding: AppToolBinding) {
  const store = getAppStudioStore();
  if (!store) throw new Error('AppStudioStore not wired.');
  const session = binding.resolveAppSession(store);
  if (!session) throw new Error(`No AppStudioSession bound to ${binding.describeBinding()}.`);
  const spec = parseAppSpec(session.spec_json);
  if (!spec) throw new Error('No approved app spec found.');
  const specRevision = store.getLatestApprovedSpecRevision(session.id);
  const architectureRevision = store.getLatestApprovedArchitectureRevision(session.id);
  const architecture = parseAppArchitecturePlan(architectureRevision?.architecture_json);
  const productRevision = store.getLatestApprovedProductRevision(session.id);
  const product = parseAppProductModel(productRevision?.product_json);
  return { store, session, spec, specRevision, productRevision, product, architectureRevision, architecture };
}

function writeArtifact(ctx: Parameters<CoderTool['handler']>[1], relative: string, contents: string): void {
  const resolved = resolveHostPath('.', ctx);
  if (resolved.kind === 'no-bind-mount') return;
  const target = join(resolved.path, ...relative.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, 'utf8');
}

export function appGetUx(binding: AppToolBinding): CoderTool {
  const parameters: JsonSchema = {
    type: 'object',
    properties: {
      view: { type: 'string', enum: ['summary', 'directions', 'tokens', 'references', 'full'], description: "Default: 'summary'." },
      ...PAGE_PROPERTIES,
    },
    additionalProperties: false,
  };
  return { name: 'app_get_ux', description: 'Read a progressive projection of the latest UX direction and audit.', parameters, source: 'native', handler: async (args) => {
    try {
      const { store, session } = context(binding);
      const revision = store.getLatestUxRevision(session.id);
      const brief = parseAppUxBrief(revision?.ux_json);
      const audit = auditAppUxBrief(brief);
      if (!brief) return appResult('App UX — summary', { revision: null, brief: null, audit: compactAudit(audit) });
      const { ux_json: _uxJson, ...revisionMeta } = revision!;
      const view = viewArg(args, ['summary', 'directions', 'tokens', 'references', 'full'], 'summary');
      const base = {
        view,
        revision: revisionMeta,
        summary: brief.summary,
        selected_direction_id: brief.selected_direction_id,
        navigation: brief.navigation,
        counts: { directions: brief.directions.length, references: brief.references.length },
        audit: compactAudit(audit),
      };
      if (view === 'full') return appResult('App UX — full', { ...base, brief, audit });
      if (view === 'directions') return appResult('App UX — directions', { ...base, ...pageItems(brief.directions, args, (item) => item.id) });
      if (view === 'tokens') return appResult('App UX — tokens', { ...base, tokens: brief.tokens, accessibility: brief.accessibility });
      if (view === 'references') return appResult('App UX — references', { ...base, ...pageItems(brief.references, args, (item) => item.value) });
      return appResult('App UX — summary', { ...base, principles: brief.principles, constraints: brief.constraints });
    } catch (e) { return err(`app_get_ux failed: ${(e as Error).message}`); }
  } };
}

export function appSaveUx(binding: AppToolBinding): CoderTool {
  return { name: 'app_save_ux', description: 'Save the complete UX brief for the current approved spec, architecture and data model. Exactly three guided directions are required.', parameters: WRAPPED('brief'), source: 'native', riskLevel: 'write', handler: async (args, ctx) => {
    try {
      const c = context(binding);
      const state = parsePipelineState(c.session.pipeline_json);
      if (!state) return err('The app pipeline is missing or invalid. Use Repair app before saving UX.');
      if (currentStage(state)?.id !== 'ux') return err(`UX is locked while current stage is '${currentStage(state)?.id ?? 'none'}'.`);
      if (!c.architectureRevision || !c.architecture) return err('Approve architecture before UX.');
      const brief = normalizeAppUxBrief(args.brief, { specRevisionId: c.specRevision?.id ?? null, architectureRevisionId: c.architectureRevision.id, dataFingerprint: dataModelFingerprint(c.spec) });
      const audit = auditAppUxBrief(brief);
      if (!audit.ok) return err(['UX audit failed:', ...audit.issues.map((issue) => `  - ${issue}`)].join('\n'));
      const json = serializeExperienceArtifact(brief);
      const revision = c.store.saveUxRevision({ app_session_id: c.session.id, spec_revision_id: c.specRevision?.id ?? null, architecture_revision_id: c.architectureRevision.id, data_fingerprint: brief.data_fingerprint, ux_json: json });
      writeArtifact(ctx, 'spec/app-ux.json', json);
      return appResult('App UX saved', { revision, audit, next: "Submit stage 'ux' for user review." });
    } catch (e) { return err(`app_save_ux failed: ${(e as Error).message}`); }
  } };
}

export function appUxAudit(binding: AppToolBinding): CoderTool {
  return { name: 'app_ux_audit', description: 'Audit the latest UX brief.', parameters: EMPTY, source: 'native', handler: async () => {
    try { const c = context(binding); const revision = c.store.getLatestUxRevision(c.session.id); return appResult('App UX audit', auditAppUxBrief(parseAppUxBrief(revision?.ux_json))); }
    catch (e) { return err(`app_ux_audit failed: ${(e as Error).message}`); }
  } };
}

export function appGetWireframe(binding: AppToolBinding): CoderTool {
  const parameters: JsonSchema = {
    type: 'object',
    properties: {
      view: { type: 'string', enum: ['summary', 'flows', 'screens', 'tests', 'groups', 'tasks', 'full'], description: "Default: 'summary'." },
      ...PAGE_PROPERTIES,
    },
    additionalProperties: false,
  };
  return { name: 'app_get_wireframe', description: 'Read a progressive projection of flows, screens, tests and the ordered build plan.', parameters, source: 'native', handler: async (args) => {
    try {
      const c = context(binding); const revision = c.store.getLatestWireframeRevision(c.session.id); const plan = parseAppWireframePlan(revision?.wireframe_json);
      const audit = auditAppWireframePlan(plan, c.spec, c.architecture, c.product);
      if (!revision || !plan) return appResult('App wireframe — summary', { revision: null, plan: null, audit: compactAudit(audit) });
      const { wireframe_json: _wireframeJson, ...revisionMeta } = revision;
      const view = viewArg(args, ['summary', 'flows', 'screens', 'tests', 'groups', 'tasks', 'full'], 'summary');
      const groupStates = c.store.listBuildGroups(revision.id);
      const taskEvidence = c.store.listBuildTaskEvidence(revision.id);
      const base = {
        view,
        revision: revisionMeta,
        summary: plan.summary,
        counts: {
          flows: plan.flows.length,
          screens: plan.screens.length,
          tests: plan.tdd_cases.length,
          groups: plan.build_groups.length,
          tasks: plan.tasks.length,
        },
        audit: compactAudit(audit),
      };
      if (view === 'full') return appResult('App wireframe — full', { ...base, plan, audit, group_states: groupStates, task_evidence: taskEvidence });
      if (view === 'flows') return appResult('App wireframe — flows', { ...base, ...pageItems(plan.flows, args, (item) => item.id) });
      if (view === 'screens') return appResult('App wireframe — screens', { ...base, ...pageItems(plan.screens, args, (item) => item.screen_id) });
      if (view === 'tests') return appResult('App wireframe — tests', { ...base, ...pageItems(plan.tdd_cases, args, (item) => item.id) });
      if (view === 'groups') {
        const page = pageItems(plan.build_groups, args, (item) => item.id);
        return appResult('App wireframe — groups', { ...base, ...page, group_states: groupStates.filter((state) => page.items.some((group) => group.id === state.group_id)) });
      }
      if (view === 'tasks') {
        const page = pageItems(plan.tasks, args, (item) => item.id);
        return appResult('App wireframe — tasks', { ...base, ...page, task_evidence: taskEvidence.filter((evidence) => page.items.some((task) => task.id === evidence.task_id)) });
      }
      return appResult('App wireframe — summary', { ...base, group_states: groupStates, completed_tasks: taskEvidence.filter((item) => item.status === 'done').length });
    } catch (e) { return err(`app_get_wireframe failed: ${(e as Error).message}`); }
  } };
}

export function appSaveWireframe(binding: AppToolBinding): CoderTool {
  return { name: 'app_save_wireframe', description: 'Save flows, low-fidelity screen wireframes, executable browser TDD cases and the ordered build plan.', parameters: WRAPPED('plan'), source: 'native', riskLevel: 'write', handler: async (args, ctx) => {
    try {
      const c = context(binding); const state = parsePipelineState(c.session.pipeline_json);
      if (!state) return err('The app pipeline is missing or invalid. Use Repair app before saving wireframes.');
      if (currentStage(state)?.id !== 'wireframe') return err(`Wireframes are locked while current stage is '${currentStage(state)?.id ?? 'none'}'.`);
      const uxRevision = c.store.getLatestApprovedUxRevision(c.session.id);
      if (!uxRevision) return err('Approve the UX direction before wireframes.');
      const plan = normalizeAppWireframePlan(args.plan, { specRevisionId: c.specRevision?.id ?? null, architectureRevisionId: c.architectureRevision?.id ?? null, uxRevisionId: uxRevision.id, dataFingerprint: dataModelFingerprint(c.spec) });
      const audit = auditAppWireframePlan(plan, c.spec, c.architecture, c.product);
      if (!audit.ok) return err(['Wireframe audit failed:', ...audit.issues.map((issue) => `  - ${issue}`)].join('\n'));
      const json = serializeExperienceArtifact(plan);
      const revision = c.store.saveWireframeRevision({ app_session_id: c.session.id, spec_revision_id: c.specRevision?.id ?? null, architecture_revision_id: c.architectureRevision?.id ?? null, ux_revision_id: uxRevision.id, data_fingerprint: plan.data_fingerprint, wireframe_json: json });
      writeArtifact(ctx, 'spec/app-wireframes.json', json);
      return appResult('App wireframe saved', { revision, audit, groups: plan.build_groups.length, tasks: plan.tasks.length, next: "Submit stage 'wireframe' for user review." });
    } catch (e) { return err(`app_save_wireframe failed: ${(e as Error).message}`); }
  } };
}

export function appWireframeAudit(binding: AppToolBinding): CoderTool {
  return { name: 'app_wireframe_audit', description: 'Audit coverage, data bindings, UI TDD traceability and build-plan dependencies.', parameters: EMPTY, source: 'native', handler: async () => {
    try { const c = context(binding); const revision = c.store.getLatestWireframeRevision(c.session.id); return appResult('App wireframe audit', auditAppWireframePlan(parseAppWireframePlan(revision?.wireframe_json), c.spec, c.architecture, c.product)); }
    catch (e) { return err(`app_wireframe_audit failed: ${(e as Error).message}`); }
  } };
}
