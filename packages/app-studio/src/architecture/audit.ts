import type { AppSpec } from '../spec/types.js';
import {
  APP_ARCHITECTURE_SOURCE_DOMAINS,
  APP_STACK_PROFILE_ID,
  type AppArchitecturePlan,
} from './types.js';

export interface AppArchitectureAudit {
  ok: boolean;
  issues: string[];
  required_source_ids: string[];
  covered_source_ids: string[];
}

export function requiredTestSourceIds(spec: AppSpec): string[] {
  const ids: string[] = [];
  for (let i = 0; i < (spec.requirements?.acceptance_criteria?.length ?? 0); i += 1) ids.push(`acceptance:${i}`);
  for (let i = 0; i < (spec.requirements?.business_rules?.length ?? 0); i += 1) ids.push(`rule:${i}`);
  for (const behavior of spec.behaviors ?? []) ids.push(`behavior:${behavior.id}`);
  for (const entity of spec.database.entities) ids.push(`entity:${entity.name}`);
  if (spec.auth.enabled) ids.push('auth');
  return ids;
}

export function auditAppArchitecture(plan: AppArchitecturePlan | null, spec: AppSpec | null): AppArchitectureAudit {
  const issues: string[] = [];
  if (!plan) {
    return { ok: false, issues: ['No architecture plan saved.'], required_source_ids: [], covered_source_ids: [] };
  }
  if (!spec) issues.push('The app spec is missing.');
  if (plan.stack_profile_id !== APP_STACK_PROFILE_ID) issues.push(`Unsupported stack profile '${plan.stack_profile_id}'.`);
  if (!plan.summary.trim()) issues.push('Architecture summary is required.');
  if (plan.modules.length === 0) issues.push('Describe at least one architecture module.');
  if (plan.decisions.length === 0) issues.push('Record at least one architecture decision.');
  if (plan.sources.length === 0) issues.push('Include at least one checked official documentation source.');
  if (!plan.tdd.strategy.trim()) issues.push('Describe the test strategy.');
  if (plan.tdd.cases.length === 0) issues.push('Define at least one test case.');

  const sourceUrls = new Set<string>();
  for (const source of plan.sources) {
    let url: URL | null = null;
    try {
      url = new URL(source.url);
    } catch {
      issues.push(`Source '${source.title}' has an invalid URL.`);
    }
    if (url && !APP_ARCHITECTURE_SOURCE_DOMAINS.some((domain) => url!.hostname === domain || url!.hostname.endsWith(`.${domain}`))) {
      issues.push(`Source '${source.url}' is not from an approved official documentation domain.`);
    }
    if (!source.title.trim() || !source.notes.trim()) issues.push(`Source '${source.url}' needs a title and relevance note.`);
    const checkedAt = Date.parse(source.checked_at);
    if (Number.isNaN(checkedAt)) {
      issues.push(`Source '${source.url}' has an invalid checked_at date.`);
    } else if (Date.now() - checkedAt > 45 * 24 * 60 * 60 * 1000) {
      issues.push(`Source '${source.url}' was checked more than 45 days ago; refresh the official research.`);
    }
    sourceUrls.add(source.url);
  }

  const moduleIds = new Set(plan.modules.map((module) => module.id));
  for (const module of plan.modules) {
    if (!module.id.trim() || !module.name.trim() || !module.responsibility.trim()) issues.push('Every module needs id, name and responsibility.');
    for (const dependency of module.depends_on) {
      if (!moduleIds.has(dependency)) issues.push(`Module '${module.id}' depends on unknown module '${dependency}'.`);
    }
  }
  for (const decision of plan.decisions) {
    if (!decision.id.trim() || !decision.title.trim() || !decision.decision.trim() || !decision.rationale.trim()) {
      issues.push('Every decision needs id, title, decision and rationale.');
    }
    for (const url of decision.source_urls) {
      if (!sourceUrls.has(url)) issues.push(`Decision '${decision.id}' references an unregistered source '${url}'.`);
    }
  }

  const required = spec ? requiredTestSourceIds(spec) : [];
  const covered = new Set<string>();
  const caseIds = new Set<string>();
  for (const testCase of plan.tdd.cases) {
    if (caseIds.has(testCase.id)) issues.push(`Duplicate test case id '${testCase.id}'.`);
    caseIds.add(testCase.id);
    if (!testCase.id.trim() || !testCase.title.trim() || !testCase.expected.trim()) {
      issues.push('Every test case needs id, title and expected result.');
    }
    if (testCase.steps.length === 0) issues.push(`Test case '${testCase.id}' has no steps.`);
    for (const sourceId of testCase.source_ids) covered.add(sourceId);
  }
  for (const sourceId of required) {
    if (!covered.has(sourceId)) issues.push(`No test covers spec item '${sourceId}'.`);
  }

  return {
    ok: issues.length === 0,
    issues: [...new Set(issues)],
    required_source_ids: required,
    covered_source_ids: [...covered].sort(),
  };
}
