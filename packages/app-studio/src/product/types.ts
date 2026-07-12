import { createHash } from 'node:crypto';
import type { AppSpec } from '../spec/types.js';

export type AppProductComplexity = 'simple' | 'standard' | 'complex' | 'very-complex';
export type AppProductHorizon = 'core' | 'complete' | 'future' | 'declined';
export type AppProductProvenance = 'user' | 'inferred' | 'researched' | 'existing';
export type AppProductScenarioKind =
  | 'success'
  | 'validation-error'
  | 'permission'
  | 'state-transition'
  | 'concurrency'
  | 'time'
  | 'reconnection'
  | 'recovery';

export interface AppProductPersona {
  id: string;
  name: string;
  goals: string[];
  permissions: string[];
}

export interface AppProductScenario {
  id: string;
  capability_id: string;
  kind: AppProductScenarioKind;
  title: string;
  given: string[];
  when: string;
  then: string[];
  source_ids: string[];
}

export interface AppProductCapability {
  id: string;
  domain_id: string;
  name: string;
  description: string;
  horizon: AppProductHorizon;
  provenance: AppProductProvenance;
  selected: boolean;
  critical: boolean;
  rationale: string;
  actor_ids: string[];
  rule_ids: string[];
  entity_names: string[];
  screen_ids: string[];
  quality_attributes: string[];
  research_source_ids: string[];
}

export interface AppProductDomain {
  id: string;
  name: string;
  description: string;
  capability_ids: string[];
}

export interface AppProductDecision {
  id: string;
  question: string;
  status: 'open' | 'decided';
  blocking: boolean;
  decision: string | null;
}

export interface AppProductResearchSource {
  id: string;
  title: string;
  url: string;
  publisher: string;
  accessed_at: string;
  supports_capability_ids: string[];
}

export interface AppProductModel {
  v: 1;
  base_spec_revision_id: number | null;
  summary: string;
  complexity: AppProductComplexity;
  complexity_factors: string[];
  personas: AppProductPersona[];
  domains: AppProductDomain[];
  capabilities: AppProductCapability[];
  scenarios: AppProductScenario[];
  journeys: Array<{ id: string; name: string; actor_id: string; capability_ids: string[]; outcome: string }>;
  non_functional_requirements: string[];
  assumptions: string[];
  risks: string[];
  decisions: AppProductDecision[];
  research_sources: AppProductResearchSource[];
  candidate_spec: AppSpec;
}

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const strings = (value: unknown): string[] => Array.isArray(value) ? value.map(text).filter(Boolean) : [];
const bool = (value: unknown): boolean => value === true;
const oneOf = <T extends string>(value: unknown, values: readonly T[], fallback: T): T =>
  typeof value === 'string' && values.includes(value as T) ? value as T : fallback;

export function normalizeAppProductModel(value: unknown, baseSpecRevisionId?: number | null): AppProductModel {
  const raw = record(value);
  const candidate = raw.candidate_spec as AppSpec;
  return {
    v: 1,
    base_spec_revision_id: baseSpecRevisionId === undefined
      ? (typeof raw.base_spec_revision_id === 'number' ? raw.base_spec_revision_id : null)
      : baseSpecRevisionId,
    summary: text(raw.summary),
    complexity: oneOf(raw.complexity, ['simple', 'standard', 'complex', 'very-complex'] as const, 'standard'),
    complexity_factors: strings(raw.complexity_factors),
    personas: (Array.isArray(raw.personas) ? raw.personas : []).map((item) => {
      const persona = record(item);
      return { id: text(persona.id), name: text(persona.name), goals: strings(persona.goals), permissions: strings(persona.permissions) };
    }),
    domains: (Array.isArray(raw.domains) ? raw.domains : []).map((item) => {
      const domain = record(item);
      return { id: text(domain.id), name: text(domain.name), description: text(domain.description), capability_ids: strings(domain.capability_ids) };
    }),
    capabilities: (Array.isArray(raw.capabilities) ? raw.capabilities : []).map((item) => {
      const capability = record(item);
      return {
        id: text(capability.id), domain_id: text(capability.domain_id), name: text(capability.name), description: text(capability.description),
        horizon: oneOf(capability.horizon, ['core', 'complete', 'future', 'declined'] as const, 'core'),
        provenance: oneOf(capability.provenance, ['user', 'inferred', 'researched', 'existing'] as const, 'inferred'),
        selected: bool(capability.selected), critical: bool(capability.critical), rationale: text(capability.rationale),
        actor_ids: strings(capability.actor_ids), rule_ids: strings(capability.rule_ids), entity_names: strings(capability.entity_names),
        screen_ids: strings(capability.screen_ids), quality_attributes: strings(capability.quality_attributes),
        research_source_ids: strings(capability.research_source_ids),
      };
    }),
    scenarios: (Array.isArray(raw.scenarios) ? raw.scenarios : []).map((item) => {
      const scenario = record(item);
      return {
        id: text(scenario.id), capability_id: text(scenario.capability_id),
        kind: oneOf(scenario.kind, ['success', 'validation-error', 'permission', 'state-transition', 'concurrency', 'time', 'reconnection', 'recovery'] as const, 'success'),
        title: text(scenario.title), given: strings(scenario.given), when: text(scenario.when), then: strings(scenario.then), source_ids: strings(scenario.source_ids),
      };
    }),
    journeys: (Array.isArray(raw.journeys) ? raw.journeys : []).map((item) => {
      const journey = record(item);
      return { id: text(journey.id), name: text(journey.name), actor_id: text(journey.actor_id), capability_ids: strings(journey.capability_ids), outcome: text(journey.outcome) };
    }),
    non_functional_requirements: strings(raw.non_functional_requirements), assumptions: strings(raw.assumptions), risks: strings(raw.risks),
    decisions: (Array.isArray(raw.decisions) ? raw.decisions : []).map((item) => {
      const decision = record(item);
      return { id: text(decision.id), question: text(decision.question), status: oneOf(decision.status, ['open', 'decided'] as const, 'open'), blocking: bool(decision.blocking), decision: text(decision.decision) || null };
    }),
    research_sources: (Array.isArray(raw.research_sources) ? raw.research_sources : []).map((item) => {
      const source = record(item);
      return { id: text(source.id), title: text(source.title), url: text(source.url), publisher: text(source.publisher), accessed_at: text(source.accessed_at), supports_capability_ids: strings(source.supports_capability_ids) };
    }),
    candidate_spec: candidate,
  };
}

export function parseAppProductModel(raw: string | null | undefined): AppProductModel | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as AppProductModel;
    if (value?.v !== 1 || value.candidate_spec?.v !== 1) return null;
    return normalizeAppProductModel(value);
  } catch { return null; }
}

export function serializeAppProductModel(model: AppProductModel): string {
  return `${JSON.stringify(model, null, 2)}\n`;
}

export function productModelFingerprint(model: AppProductModel): string {
  return createHash('sha256').update(JSON.stringify({
    complexity: model.complexity,
    domains: model.domains,
    capabilities: model.capabilities,
    scenarios: model.scenarios,
    decisions: model.decisions,
    candidate_spec: model.candidate_spec,
  })).digest('hex');
}
