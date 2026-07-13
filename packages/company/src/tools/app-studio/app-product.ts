import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { err } from '@mcp/code-agent/core/tool.js';
import { webSearch } from '@mcp/code-agent/tools/web.js';
import { auditAppProductModel } from '@mcp/app-studio/product/audit.js';
import { recoverProductModel } from '@mcp/app-studio/product/recover.js';
import {
  normalizeAppProductModel,
  parseAppProductModel,
  productModelFingerprint,
  serializeAppProductModel,
  type AppProductCapability,
  type AppProductDomain,
  type AppProductModel,
  type AppProductResearchSource,
  type AppProductScenario,
} from '@mcp/app-studio/product/types.js';
import { currentStage, parsePipelineState } from '@mcp/app-studio/pipeline/stages.js';
import { parseAppSpec } from '@mcp/app-studio/spec/types.js';
import type { AppToolBinding } from './binding.js';
import { getAppStudioStore } from './store-binding.js';
import { appResult, compactAudit, PAGE_PROPERTIES, pageItems, viewArg } from './model-output.js';

const EMPTY: JsonSchema = { type: 'object', properties: {}, additionalProperties: false };
const GET_PARAMETERS: JsonSchema = {
  type: 'object',
  properties: {
    view: {
      type: 'string',
      enum: ['summary', 'domains', 'capabilities', 'scenarios', 'decisions', 'research', 'candidate_spec', 'full'],
      description: "Projection to return. Default: 'summary'.",
    },
    ...PAGE_PROPERTIES,
  },
  additionalProperties: false,
};
const EXPECTED = { expected_revision_number: { type: 'number', description: 'Revision number returned by app_get_product_model. Required when editing an existing draft.' } };

function context(binding: AppToolBinding) {
  const store = getAppStudioStore();
  if (!store) throw new Error('AppStudioStore not wired.');
  const session = binding.resolveAppSession(store);
  if (!session) throw new Error(`No AppStudioSession bound to ${binding.describeBinding()}.`);
  const spec = parseAppSpec(session.spec_json);
  if (!spec) throw new Error('Save the initial app idea before modeling the product.');
  const specRevision = store.getLatestApprovedSpecRevision(session.id);
  const revision = store.getLatestProductRevision(session.id);
  const model = parseAppProductModel(revision?.product_json) ?? recoverProductModel(spec, specRevision?.id ?? null);
  return { store, session, spec, specRevision, revision, model };
}

function assertEditable(c: ReturnType<typeof context>): void {
  const state = parsePipelineState(c.session.pipeline_json);
  if (!state) throw new Error('The app pipeline is missing or invalid. Use Repair app first.');
  const current = currentStage(state);
  if (current?.id !== 'product' || current.status === 'review') throw new Error(`Product modeling is locked while current stage is '${current?.id ?? 'none'}'.`);
}

function save(c: ReturnType<typeof context>, model: AppProductModel, expected: unknown) {
  assertEditable(c);
  const expectedRevision = typeof expected === 'number' ? expected : null;
  if (c.revision?.status === 'draft' && expectedRevision == null) throw new Error('expected_revision_number is required to edit an existing draft. Reload with app_get_product_model.');
  const normalized = normalizeAppProductModel(model, c.specRevision?.id ?? null);
  return c.store.saveProductRevision({
    app_session_id: c.session.id,
    base_revision_id: c.store.getLatestApprovedProductRevision(c.session.id)?.id ?? null,
    base_spec_revision_id: c.specRevision?.id ?? null,
    complexity: normalized.complexity,
    research_fingerprint: productModelFingerprint(normalized),
    product_json: serializeAppProductModel(normalized),
  }, c.revision?.status === 'draft' ? expectedRevision : null);
}

function revisionMeta(revision: ReturnType<typeof context>['revision']) {
  if (!revision) return null;
  const { product_json: _productJson, ...meta } = revision;
  return meta;
}

function response(c: ReturnType<typeof context>, model: AppProductModel, persisted: boolean, args: Record<string, unknown>) {
  const view = viewArg(args, ['summary', 'domains', 'capabilities', 'scenarios', 'decisions', 'research', 'candidate_spec', 'full'], 'summary');
  const audit = auditAppProductModel(model);
  const base = {
    view,
    revision: revisionMeta(c.revision),
    persisted,
    fingerprint: productModelFingerprint(model),
    summary: model.summary,
    complexity: model.complexity,
    complexity_factors: model.complexity_factors,
    counts: {
      personas: model.personas.length,
      domains: model.domains.length,
      capabilities: model.capabilities.length,
      selected_capabilities: model.capabilities.filter((item) => item.selected).length,
      scenarios: model.scenarios.length,
      decisions: model.decisions.length,
      open_decisions: model.decisions.filter((item) => item.status === 'open').length,
      research_sources: model.research_sources.length,
    },
    audit: compactAudit(audit),
  };
  if (view === 'full') return appResult('Product model — full', { ...base, model, audit });
  if (view === 'summary') return appResult('Product model — summary', { ...base, personas: model.personas });
  if (view === 'domains') return appResult('Product model — domains', { ...base, ...pageItems(model.domains, args, (item) => item.id) });
  if (view === 'capabilities') return appResult('Product model — capabilities', { ...base, ...pageItems(model.capabilities, args, (item) => item.id) });
  if (view === 'scenarios') return appResult('Product model — scenarios', { ...base, ...pageItems(model.scenarios, args, (item) => item.id) });
  if (view === 'decisions') return appResult('Product model — decisions', { ...base, ...pageItems(model.decisions, args, (item) => item.id) });
  if (view === 'research') return appResult('Product model — research', { ...base, ...pageItems(model.research_sources, args, (item) => item.id) });
  return appResult('Product model — candidate spec', { ...base, candidate_spec: model.candidate_spec });
}

export function appGetProductModel(binding: AppToolBinding): CoderTool {
  return { name: 'app_get_product_model', description: 'Read a progressive projection of the authoritative product map. The summary includes the revision number required by edits; request only the section you need.', parameters: GET_PARAMETERS, source: 'native', handler: async (args) => {
    try { const c = context(binding); return response(c, c.model, !!c.revision, args); }
    catch (e) { return err(`app_get_product_model failed: ${(e as Error).message}`); }
  } };
}

const DOMAIN_SCHEMA: JsonSchema = { type: 'object', properties: { ...EXPECTED, domain: { type: 'object', description: 'Complete domain with stable id, name, description and capability_ids.' } }, required: ['domain'], additionalProperties: false };
export function appUpsertProductDomain(binding: AppToolBinding): CoderTool {
  return { name: 'app_upsert_product_domain', description: 'Create or replace one domain without resending the complete product model.', parameters: DOMAIN_SCHEMA, source: 'native', riskLevel: 'write', handler: async (args) => {
    try {
      const c = context(binding); const domain = args.domain as AppProductDomain;
      if (!domain?.id) return err('domain.id is required and must remain stable.');
      const next = structuredClone(c.model); const index = next.domains.findIndex((item) => item.id === domain.id);
      if (index >= 0) next.domains[index] = domain; else next.domains.push(domain);
      const revision = save(c, next, args.expected_revision_number); return appResult('Product domain saved', { revision: revisionMeta(revision), domain_id: domain.id, next: 'Reload the product model before the next edit.' });
    } catch (e) { return err(`app_upsert_product_domain failed: ${(e as Error).message}`); }
  } };
}

const CAPABILITY_SCHEMA: JsonSchema = { type: 'object', properties: { ...EXPECTED, capability: { type: 'object', description: 'Complete capability with stable id, horizon, provenance, selection and traceability.' } }, required: ['capability'], additionalProperties: false };
export function appUpsertProductCapability(binding: AppToolBinding): CoderTool {
  return { name: 'app_upsert_product_capability', description: 'Create or replace one product capability atomically.', parameters: CAPABILITY_SCHEMA, source: 'native', riskLevel: 'write', handler: async (args) => {
    try {
      const c = context(binding); const capability = args.capability as AppProductCapability;
      if (!capability?.id || !capability.domain_id) return err('capability.id and capability.domain_id are required.');
      const next = structuredClone(c.model); const index = next.capabilities.findIndex((item) => item.id === capability.id);
      if (index >= 0) next.capabilities[index] = capability; else next.capabilities.push(capability);
      const domain = next.domains.find((item) => item.id === capability.domain_id);
      if (domain && !domain.capability_ids.includes(capability.id)) domain.capability_ids.push(capability.id);
      const revision = save(c, next, args.expected_revision_number); return appResult('Product capability saved', { revision: revisionMeta(revision), capability_id: capability.id, next: 'Reload the product model before the next edit.' });
    } catch (e) { return err(`app_upsert_product_capability failed: ${(e as Error).message}`); }
  } };
}

const SCENARIO_SCHEMA: JsonSchema = { type: 'object', properties: { ...EXPECTED, scenario: { type: 'object', description: 'One executable product scenario linked to one capability.' } }, required: ['scenario'], additionalProperties: false };
export function appUpsertProductScenario(binding: AppToolBinding): CoderTool {
  return { name: 'app_upsert_product_scenario', description: 'Create or replace one capability scenario atomically.', parameters: SCENARIO_SCHEMA, source: 'native', riskLevel: 'write', handler: async (args) => {
    try {
      const c = context(binding); const scenario = args.scenario as AppProductScenario;
      if (!scenario?.id || !scenario.capability_id) return err('scenario.id and scenario.capability_id are required.');
      const next = structuredClone(c.model); const index = next.scenarios.findIndex((item) => item.id === scenario.id);
      if (index >= 0) next.scenarios[index] = scenario; else next.scenarios.push(scenario);
      const revision = save(c, next, args.expected_revision_number); return appResult('Product scenario saved', { revision: revisionMeta(revision), scenario_id: scenario.id, next: 'Reload the product model before the next edit.' });
    } catch (e) { return err(`app_upsert_product_scenario failed: ${(e as Error).message}`); }
  } };
}

const SOURCE_SCHEMA: JsonSchema = { type: 'object', properties: { ...EXPECTED, source: { type: 'object', description: 'One public research source with stable id, title, URL, publisher, access date and supported capability ids.' } }, required: ['source'], additionalProperties: false };
export function appUpsertProductResearchSource(binding: AppToolBinding): CoderTool {
  return { name: 'app_upsert_product_research_source', description: 'Persist one selected public research citation without resending the complete product model.', parameters: SOURCE_SCHEMA, source: 'native', riskLevel: 'write', handler: async (args) => {
    try {
      const c = context(binding); const source = args.source as AppProductResearchSource;
      if (!source?.id || !source.url) return err('source.id and source.url are required.');
      const next = structuredClone(c.model); const index = next.research_sources.findIndex((item) => item.id === source.id);
      if (index >= 0) next.research_sources[index] = source; else next.research_sources.push(source);
      const audit = auditAppProductModel(next);
      const sourceIssues = audit.issues.filter((issue) => issue.includes(`source '${source.id}'`));
      if (sourceIssues.length) return err(sourceIssues.join('\n'));
      const revision = save(c, next, args.expected_revision_number); return appResult('Product research source saved', { revision: revisionMeta(revision), source_id: source.id, next: 'Reload the product model before linking this source to capabilities.' });
    } catch (e) { return err(`app_upsert_product_research_source failed: ${(e as Error).message}`); }
  } };
}

const SCOPE_SCHEMA: JsonSchema = {
  type: 'object', properties: {
    ...EXPECTED,
    selections: { type: 'array', items: { type: 'object' }, description: 'Items { capability_id, selected, horizon } explicitly confirmed by the user.' },
    decisions: { type: 'array', items: { type: 'object' }, description: 'Complete product decisions after the user answers.' },
    candidate_spec: { type: 'object', description: 'Complete AppSpec projection representing only the selected scope.' },
  }, required: ['selections', 'decisions', 'candidate_spec'], additionalProperties: false,
};
export function appSetProductScope(binding: AppToolBinding): CoderTool {
  return { name: 'app_set_product_scope', description: 'Apply user-confirmed scope choices and the corresponding candidate AppSpec. Inferred/researched features are never selected implicitly.', parameters: SCOPE_SCHEMA, source: 'native', riskLevel: 'write', handler: async (args) => {
    try {
      const c = context(binding); const next = structuredClone(c.model);
      for (const raw of Array.isArray(args.selections) ? args.selections as Array<Record<string, unknown>> : []) {
        const capability = next.capabilities.find((item) => item.id === String(raw.capability_id ?? ''));
        if (!capability) throw new Error(`Unknown capability '${String(raw.capability_id ?? '')}'.`);
        capability.selected = raw.selected === true;
        if (['core', 'complete', 'future', 'declined'].includes(String(raw.horizon))) capability.horizon = raw.horizon as AppProductCapability['horizon'];
      }
      next.decisions = args.decisions as AppProductModel['decisions'];
      next.candidate_spec = args.candidate_spec as AppProductModel['candidate_spec'];
      const revision = save(c, next, args.expected_revision_number);
      const audit = auditAppProductModel(next);
      return appResult('Product scope saved', { revision: revisionMeta(revision), audit, next: audit.ok ? "Submit stage 'product' for user review." : 'Resolve the semantic audit issues.' });
    } catch (e) { return err(`app_set_product_scope failed: ${(e as Error).message}`); }
  } };
}

export function appProductAudit(binding: AppToolBinding): CoderTool {
  return { name: 'app_product_audit', description: 'Audit product depth, explicit scope, research provenance, scenarios and candidate spec.', parameters: EMPTY, source: 'native', handler: async () => {
    try { const c = context(binding); return appResult('Product audit', auditAppProductModel(c.model)); }
    catch (e) { return err(`app_product_audit failed: ${(e as Error).message}`); }
  } };
}

const RESEARCH_SCHEMA: JsonSchema = { type: 'object', properties: { query: { type: 'string', description: 'Focused domain question. Use only for complex or specialized products.' } }, required: ['query'], additionalProperties: false };
export const appResearchProductDomain: CoderTool = {
  name: 'app_research_product_domain', description: 'Search current public sources for one focused product-domain question. Record selected sources and access dates in the product model.', parameters: RESEARCH_SCHEMA, source: 'native',
  handler: (args, ctx) => webSearch.handler({ query: String(args.query ?? '') }, ctx),
};

const BRIEFING_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    view: { type: 'string', enum: ['summary', 'capabilities', 'scenarios', 'full'], description: "Default: 'summary'." },
    capability_ids: { type: 'array', items: { type: 'string' }, description: 'Optional focused stable capability ids.' },
    offset: PAGE_PROPERTIES.offset,
    limit: PAGE_PROPERTIES.limit,
  },
  additionalProperties: false,
};
export function appGetStageBriefing(binding: AppToolBinding): CoderTool {
  return { name: 'app_get_stage_briefing', description: 'Return a deterministic, revision-pinned briefing for new, resumed or compacted specialist sessions. This is operational context; stage summaries are not.', parameters: BRIEFING_SCHEMA, source: 'native', handler: async (args) => {
    try {
      const c = context(binding); const focus = new Set(Array.isArray(args.capability_ids) ? args.capability_ids.map(String) : []);
      const capabilities = focus.size ? c.model.capabilities.filter((item) => focus.has(item.id)) : c.model.capabilities.filter((item) => item.selected);
      const ids = new Set(capabilities.map((item) => item.id));
      const full = {
        briefing_version: 1,
        app: { id: c.session.id, name: c.session.name },
        revisions: { spec: c.specRevision?.id ?? null, product: c.revision?.id ?? null, product_number: c.revision?.revision_number ?? null },
        fingerprint: productModelFingerprint(c.model), complexity: c.model.complexity, complexity_factors: c.model.complexity_factors,
        summary: c.model.summary, personas: c.model.personas, domains: c.model.domains.filter((item) => item.capability_ids.some((id) => ids.has(id))),
        capabilities, scenarios: c.model.scenarios.filter((item) => ids.has(item.capability_id)),
        open_decisions: c.model.decisions.filter((item) => item.status === 'open'),
        next_valid_operation: currentStage(parsePipelineState(c.session.pipeline_json)!)?.id ?? null,
      };
      const view = viewArg(args, ['summary', 'capabilities', 'scenarios', 'full'], 'summary');
      const base = {
        briefing_version: full.briefing_version,
        view,
        app: full.app,
        revisions: full.revisions,
        fingerprint: full.fingerprint,
        complexity: full.complexity,
        complexity_factors: full.complexity_factors,
        summary: full.summary,
        next_valid_operation: full.next_valid_operation,
        counts: {
          personas: full.personas.length,
          domains: full.domains.length,
          capabilities: full.capabilities.length,
          scenarios: full.scenarios.length,
          open_decisions: full.open_decisions.length,
        },
      };
      if (view === 'full') return appResult('Stage briefing — full', full);
      if (view === 'capabilities') return appResult('Stage briefing — capabilities', { ...base, ...pageItems(full.capabilities, args, (item) => item.id) });
      if (view === 'scenarios') return appResult('Stage briefing — scenarios', { ...base, ...pageItems(full.scenarios, args, (item) => item.id) });
      return appResult('Stage briefing — summary', { ...base, personas: full.personas, domains: full.domains, open_decisions: full.open_decisions.slice(0, 10) });
    } catch (e) { return err(`app_get_stage_briefing failed: ${(e as Error).message}`); }
  } };
}
