import type { AppArchitecturePlan } from '../architecture/types.js';
import type { AppSpec } from '../spec/types.js';
import { architectureDesignCaseIds, type AppUxBrief, type AppWireframePlan } from './types.js';

export interface AppExperienceAudit { ok: boolean; issues: string[] }
const unique = (items: string[]): boolean => new Set(items).size === items.length;

export function auditAppUxBrief(brief: AppUxBrief | null): AppExperienceAudit {
  const issues: string[] = [];
  if (!brief) return { ok: false, issues: ['No UX brief saved.'] };
  if (!brief.summary) issues.push('UX summary is required.');
  if (brief.directions.length !== 3) issues.push('Exactly three guided UX directions are required.');
  if (!unique(brief.directions.map((item) => item.id))) issues.push('UX direction ids must be unique.');
  const selected = brief.directions.find((item) => item.id === brief.selected_direction_id);
  if (!selected) issues.push('Select one of the three UX directions.');
  for (const direction of brief.directions) {
    if (!direction.id || !direction.name || !direction.rationale || direction.palette.length < 3 || !direction.typography) {
      issues.push(`UX direction '${direction.id || '?'}' needs a name, rationale, at least three colors and typography.`);
    }
  }
  for (const [key, value] of Object.entries(brief.tokens)) if (!String(value).trim()) issues.push(`UX token '${key}' is required.`);
  if (!brief.navigation) issues.push('Navigation shell decision is required.');
  if (brief.principles.length < 3) issues.push('Record at least three UX principles.');
  if (brief.constraints.length === 0) issues.push('Record at least one visual or usability constraint.');
  for (const [key, value] of Object.entries(brief.accessibility)) if (!String(value).trim()) issues.push(`Accessibility decision '${key}' is required.`);
  return { ok: issues.length === 0, issues: [...new Set(issues)] };
}

export function auditAppWireframePlan(
  plan: AppWireframePlan | null,
  spec: AppSpec | null,
  architecture: AppArchitecturePlan | null,
): AppExperienceAudit {
  const issues: string[] = [];
  if (!plan) return { ok: false, issues: ['No wireframe plan saved.'] };
  if (!spec) return { ok: false, issues: ['App spec is missing.'] };
  if (!plan.summary) issues.push('Wireframe summary is required.');
  if (plan.flows.length === 0) issues.push('Define at least one user flow.');
  const screenIds = new Set(spec.screens.map((screen) => screen.id));
  const entityFields = new Map(spec.database.entities.map((entity) => [entity.name, new Set(entity.fields.map((field) => field.name))]));
  const entityNames = new Set(entityFields.keys());
  const requiredSourceIds = [
    ...spec.features.map((feature) => `feature:${feature.id}`),
    ...(spec.behaviors ?? []).map((behavior) => `behavior:${behavior.id}`),
    ...(spec.requirements?.acceptance_criteria ?? []).map((_, index) => `acceptance:${index}`),
  ];
  const plannedScreens = plan.screens.map((screen) => screen.screen_id);
  if (!unique(plannedScreens)) issues.push('Each screen must have exactly one wireframe.');
  for (const id of screenIds) if (!plannedScreens.includes(id)) issues.push(`Screen '${id}' has no wireframe.`);
  for (const screen of plan.screens) {
    if (!screenIds.has(screen.screen_id)) issues.push(`Wireframe references unknown screen '${screen.screen_id}'.`);
    if (!screen.route || screen.hierarchy.length === 0 || screen.regions.length === 0 || !screen.responsive) issues.push(`Wireframe '${screen.screen_id}' needs route, hierarchy, regions and responsive behavior.`);
    for (const required of ['populated', 'empty', 'error'] as const) if (!screen.states.includes(required)) issues.push(`Wireframe '${screen.screen_id}' must cover state '${required}'.`);
    if (screen.data_bindings.length > 0 && !screen.states.includes('loading')) issues.push(`Wireframe '${screen.screen_id}' reads data and must cover state 'loading'.`);
    if (spec.auth.protected_screen_ids?.includes(screen.screen_id) && !screen.states.includes('forbidden')) issues.push(`Protected wireframe '${screen.screen_id}' must cover state 'forbidden'.`);
    for (const binding of screen.data_bindings) {
      const fields = entityFields.get(binding.entity);
      if (!fields) issues.push(`Wireframe '${screen.screen_id}' binds unknown entity '${binding.entity}'.`);
      else for (const field of binding.fields) if (!fields.has(field)) issues.push(`Wireframe '${screen.screen_id}' binds unknown field '${binding.entity}.${field}'.`);
      if (!binding.fixture_scenario) issues.push(`Data binding '${binding.entity}' on '${screen.screen_id}' needs a fixture scenario.`);
    }
  }
  const flowIds = new Set(plan.flows.map((flow) => flow.id));
  if (!unique([...flowIds])) issues.push('Flow ids must be unique.');
  for (const flow of plan.flows) {
    if (!flow.id || !flow.name || !flow.goal || !screenIds.has(flow.entry_screen_id) || flow.steps.length === 0) issues.push(`Flow '${flow.id || '?'}' needs name, goal, valid entry screen and steps.`);
    const stepIds = new Set(flow.steps.map((step) => step.id));
    for (const step of flow.steps) {
      if (!screenIds.has(step.screen_id)) issues.push(`Flow '${flow.id}' step '${step.id}' uses unknown screen '${step.screen_id}'.`);
      for (const next of step.next_step_ids) if (!stepIds.has(next)) issues.push(`Flow '${flow.id}' step '${step.id}' points to unknown step '${next}'.`);
      for (const entity of [...step.reads, ...step.writes]) if (!entityNames.has(entity)) issues.push(`Flow '${flow.id}' step '${step.id}' uses unknown entity '${entity}'.`);
    }
  }
  const coveredSources = new Set([...plan.flows.flatMap((flow) => flow.source_ids), ...plan.tdd_cases.flatMap((testCase) => testCase.source_ids)]);
  for (const sourceId of requiredSourceIds) if (!coveredSources.has(sourceId)) issues.push(`Wireframe plan does not cover spec item '${sourceId}'.`);
  const expandedArchitectureCases = new Set(plan.tdd_cases.flatMap((testCase) => testCase.architecture_case_ids));
  for (const id of architectureDesignCaseIds(architecture)) if (!expandedArchitectureCases.has(id)) issues.push(`Architecture design case '${id}' is not expanded by a wireframe TDD case.`);
  const testIds = new Set(plan.tdd_cases.map((item) => item.id));
  for (const testCase of plan.tdd_cases) {
    if (!testCase.id || !testCase.title || !testCase.expected || testCase.steps.length === 0 || testCase.screen_ids.length === 0 || testCase.flow_ids.length === 0 || testCase.source_ids.length === 0) issues.push(`Wireframe TDD case '${testCase.id || '?'}' is incomplete.`);
    for (const screenId of testCase.screen_ids) if (!screenIds.has(screenId)) issues.push(`Wireframe TDD case '${testCase.id}' references unknown screen '${screenId}'.`);
    for (const flowId of testCase.flow_ids) if (!flowIds.has(flowId)) issues.push(`Wireframe TDD case '${testCase.id}' references unknown flow '${flowId}'.`);
  }
  const groupIds = new Set(plan.build_groups.map((group) => group.id));
  const taskIds = new Set(plan.tasks.map((task) => task.id));
  if (!unique([...groupIds])) issues.push('Build group ids must be unique.');
  if (!unique([...taskIds])) issues.push('Build task ids must be unique.');
  for (const group of plan.build_groups) {
    if (!group.id || !group.name || group.task_ids.length === 0) issues.push(`Build group '${group.id || '?'}' needs a name and tasks.`);
    for (const dep of group.depends_on) if (!groupIds.has(dep)) issues.push(`Build group '${group.id}' depends on unknown group '${dep}'.`);
    for (const taskId of group.task_ids) if (!taskIds.has(taskId)) issues.push(`Build group '${group.id}' references unknown task '${taskId}'.`);
    for (const flowId of group.flow_ids) if (!flowIds.has(flowId)) issues.push(`Build group '${group.id}' references unknown flow '${flowId}'.`);
    for (const screenId of group.screen_ids) if (!screenIds.has(screenId)) issues.push(`Build group '${group.id}' references unknown screen '${screenId}'.`);
    const groupTasks = plan.tasks.filter((task) => task.group_id === group.id);
    const declared = new Set(group.task_ids);
    for (const task of groupTasks) if (!declared.has(task.id)) issues.push(`Build group '${group.id}' does not declare task '${task.id}'.`);
    for (const kind of ['test-red', 'mock-contract', 'screen', 'responsive', 'accessibility', 'test-green', 'preview'] as const) {
      if (!groupTasks.some((task) => task.kind === kind)) issues.push(`Build group '${group.id}' needs a '${kind}' task.`);
    }
  }
  for (const task of plan.tasks) {
    if (!groupIds.has(task.group_id)) issues.push(`Task '${task.id}' belongs to unknown group '${task.group_id}'.`);
    if (task.screen_id && !screenIds.has(task.screen_id)) issues.push(`Task '${task.id}' references unknown screen '${task.screen_id}'.`);
    for (const dep of task.depends_on) if (!taskIds.has(dep)) issues.push(`Task '${task.id}' depends on unknown task '${dep}'.`);
    for (const testId of task.tdd_case_ids) if (!testIds.has(testId)) issues.push(`Task '${task.id}' references unknown TDD case '${testId}'.`);
  }
  for (const screenId of screenIds) if (!plan.tasks.some((task) => task.screen_id === screenId && task.kind === 'screen')) issues.push(`Screen '${screenId}' has no implementation task.`);
  for (const flowId of flowIds) if (!plan.build_groups.some((group) => group.flow_ids.includes(flowId))) issues.push(`Flow '${flowId}' is not assigned to a build group.`);
  return { ok: issues.length === 0, issues: [...new Set(issues)] };
}
