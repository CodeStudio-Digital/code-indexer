import { validateAppSpec } from '../spec/validate.js';
import type { AppProductModel, AppProductScenarioKind } from './types.js';

export interface AppProductAudit {
  ok: boolean;
  issues: string[];
  warnings: string[];
  counts: { domains: number; capabilities: number; selected: number; scenarios: number; open_decisions: number };
}

const CRITICAL_KINDS: AppProductScenarioKind[] = ['success', 'validation-error', 'permission', 'state-transition'];
const TEMPORAL_FACTORS = /real.?time|multiplayer|concurr|simultan|calendar|schedule|reconnect|offline|live|tempo|calend|ao vivo/i;

export function auditAppProductModel(model: AppProductModel | null): AppProductAudit {
  const issues: string[] = [];
  const warnings: string[] = [];
  if (!model) return { ok: false, issues: ['No product model saved.'], warnings, counts: { domains: 0, capabilities: 0, selected: 0, scenarios: 0, open_decisions: 0 } };
  const unique = (label: string, ids: string[]) => {
    const empty = ids.filter((id) => !id);
    if (empty.length) issues.push(`${label} contains empty stable ids.`);
    const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
    if (duplicates.length) issues.push(`${label} has duplicate ids: ${duplicates.join(', ')}.`);
  };
  unique('Domains', model.domains.map((item) => item.id));
  unique('Capabilities', model.capabilities.map((item) => item.id));
  unique('Scenarios', model.scenarios.map((item) => item.id));
  if (!model.summary) issues.push('Product summary is empty.');
  if (!model.complexity_factors.length) issues.push('Complexity has no supporting factors.');
  if (!model.personas.length) issues.push('At least one persona is required.');
  if (!model.domains.length) issues.push('At least one product domain is required.');
  const domainIds = new Set(model.domains.map((item) => item.id));
  const capabilityIds = new Set(model.capabilities.map((item) => item.id));
  const personaIds = new Set(model.personas.map((item) => item.id));
  const sourceIds = new Set(model.research_sources.map((item) => item.id));
  const specScreens = new Set(model.candidate_spec.screens.map((item) => item.id));
  const specEntities = new Set(model.candidate_spec.database.entities.map((item) => item.name));
  const selected = model.capabilities.filter((item) => item.selected && item.horizon !== 'declined');
  for (const source of model.research_sources) {
    try {
      const url = new URL(source.url);
      const hostname = url.hostname.toLowerCase();
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || hostname === 'localhost' || hostname.endsWith('.local') || /^(127\.|10\.|192\.168\.|0\.|::1$)/.test(hostname)) {
        issues.push(`Research source '${source.id}' must use a public http(s) URL.`);
      }
    } catch { issues.push(`Research source '${source.id}' has an invalid URL.`); }
    if (!source.title || !source.publisher || Number.isNaN(Date.parse(source.accessed_at))) issues.push(`Research source '${source.id}' needs title, publisher and a valid access date.`);
  }
  for (const domain of model.domains) {
    for (const id of domain.capability_ids) if (!capabilityIds.has(id)) issues.push(`Domain '${domain.id}' references unknown capability '${id}'.`);
  }
  for (const capability of model.capabilities) {
    if (!domainIds.has(capability.domain_id)) issues.push(`Capability '${capability.id}' references unknown domain '${capability.domain_id}'.`);
    if (!capability.name || !capability.description || !capability.rationale) issues.push(`Capability '${capability.id}' needs name, description and rationale.`);
    for (const actorId of capability.actor_ids) if (!personaIds.has(actorId)) issues.push(`Capability '${capability.id}' references unknown persona '${actorId}'.`);
    for (const sourceId of capability.research_source_ids) if (!sourceIds.has(sourceId)) issues.push(`Capability '${capability.id}' references unknown research source '${sourceId}'.`);
    if (capability.provenance === 'researched' && capability.selected && !capability.research_source_ids.length) {
      issues.push(`Researched capability '${capability.id}' cannot enter approved scope without a source.`);
    }
    if (!capability.selected) continue;
    if (capability.screen_ids.length + capability.entity_names.length + capability.rule_ids.length === 0) {
      issues.push(`Selected capability '${capability.id}' has no trace to a screen, entity or rule in the candidate spec.`);
    }
    for (const screenId of capability.screen_ids) if (!specScreens.has(screenId)) issues.push(`Capability '${capability.id}' references unknown candidate screen '${screenId}'.`);
    for (const entityName of capability.entity_names) if (!specEntities.has(entityName)) issues.push(`Capability '${capability.id}' references unknown candidate entity '${entityName}'.`);
    const kinds = new Set(model.scenarios.filter((item) => item.capability_id === capability.id).map((item) => item.kind));
    if (!kinds.has('success')) issues.push(`Selected capability '${capability.id}' needs a success scenario.`);
    if (capability.critical) {
      for (const kind of CRITICAL_KINDS) if (!kinds.has(kind)) issues.push(`Critical capability '${capability.id}' needs a '${kind}' scenario.`);
      if (TEMPORAL_FACTORS.test([capability.description, capability.quality_attributes.join(' '), ...model.complexity_factors].join(' ')) &&
        !['concurrency', 'time', 'reconnection', 'recovery'].some((kind) => kinds.has(kind as AppProductScenarioKind))) {
        issues.push(`Critical temporal capability '${capability.id}' needs a concurrency, time, reconnection or recovery scenario.`);
      }
    }
  }
  for (const scenario of model.scenarios) {
    if (!capabilityIds.has(scenario.capability_id)) issues.push(`Scenario '${scenario.id}' references unknown capability '${scenario.capability_id}'.`);
    if (!scenario.title || !scenario.when || !scenario.then.length) issues.push(`Scenario '${scenario.id}' needs title, when and expected results.`);
  }
  const blockers = model.decisions.filter((item) => item.blocking && item.status === 'open');
  if (blockers.length) issues.push(`Blocking product decisions remain open: ${blockers.map((item) => item.id).join(', ')}.`);
  issues.push(...validateAppSpec(model.candidate_spec).map((issue) => `Candidate spec: ${issue}`));
  if (model.complexity === 'complex' || model.complexity === 'very-complex') {
    if (model.domains.length < 3) warnings.push('A complex product normally needs at least three explicit domains; review the decomposition.');
    if (!model.non_functional_requirements.length) issues.push('Complex products need explicit non-functional requirements.');
  }
  return {
    ok: issues.length === 0,
    issues,
    warnings,
    counts: { domains: model.domains.length, capabilities: model.capabilities.length, selected: selected.length, scenarios: model.scenarios.length, open_decisions: model.decisions.filter((item) => item.status === 'open').length },
  };
}
