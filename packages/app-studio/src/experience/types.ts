import { createHash } from 'node:crypto';
import type { AppArchitecturePlan } from '../architecture/types.js';
import type { AppSpec } from '../spec/types.js';

export type AppUxDensity = 'compact' | 'comfortable' | 'spacious';
export type AppBuildComplexity = 'small' | 'medium' | 'large';
export type AppScreenState = 'loading' | 'populated' | 'empty' | 'error' | 'forbidden';

export interface AppUxDirection {
  id: string;
  name: string;
  rationale: string;
  palette: string[];
  typography: string;
  density: AppUxDensity;
}

export interface AppUxBrief {
  v: 1;
  spec_revision_id: number | null;
  architecture_revision_id: number | null;
  data_fingerprint: string;
  summary: string;
  directions: AppUxDirection[];
  selected_direction_id: string;
  tokens: {
    background: string;
    surface: string;
    text: string;
    muted: string;
    primary: string;
    secondary: string;
    accent: string;
    success: string;
    warning: string;
    danger: string;
    font_display: string;
    font_body: string;
    radius: string;
    spacing: string;
    density: AppUxDensity;
    motion: string;
  };
  navigation: string;
  principles: string[];
  constraints: string[];
  rejected_directions: string[];
  accessibility: {
    standard: 'WCAG 2.2 AA';
    contrast: string;
    keyboard: string;
    focus: string;
    reduced_motion: string;
  };
  references: Array<{ kind: 'image' | 'url' | 'design-system'; value: string; note: string }>;
}

export interface AppWireframeDataBinding {
  entity: string;
  fields: string[];
  purpose: string;
  fixture_scenario: string;
}

export interface AppWireframeFlowStep {
  id: string;
  screen_id: string;
  action: string;
  result: string;
  reads: string[];
  writes: string[];
  next_step_ids: string[];
}

export interface AppWireframeFlow {
  id: string;
  name: string;
  actor: string;
  goal: string;
  entry_screen_id: string;
  source_ids: string[];
  steps: AppWireframeFlowStep[];
}

export interface AppScreenWireframe {
  screen_id: string;
  route: string;
  flow_ids: string[];
  hierarchy: string[];
  regions: Array<{ id: string; purpose: string; components: string[] }>;
  actions: string[];
  data_bindings: AppWireframeDataBinding[];
  states: AppScreenState[];
  responsive: string;
  accessibility: string[];
}

export interface AppWireframeTestCase {
  id: string;
  title: string;
  architecture_case_ids: string[];
  source_ids: string[];
  flow_ids: string[];
  screen_ids: string[];
  preconditions: string[];
  steps: string[];
  expected: string;
}

export type AppBuildTaskKind = 'test-red' | 'mock-contract' | 'screen' | 'responsive' | 'accessibility' | 'test-green' | 'preview';

export interface AppBuildTask {
  id: string;
  group_id: string;
  screen_id: string | null;
  kind: AppBuildTaskKind;
  title: string;
  sequence: number;
  complexity: AppBuildComplexity;
  depends_on: string[];
  tdd_case_ids: string[];
  entity_names: string[];
  source_ids: string[];
}

export interface AppBuildGroup {
  id: string;
  name: string;
  goal: string;
  sequence: number;
  complexity: AppBuildComplexity;
  flow_ids: string[];
  capability_ids: string[];
  screen_ids: string[];
  depends_on: string[];
  task_ids: string[];
}

export interface AppWireframePlan {
  v: 1;
  spec_revision_id: number | null;
  architecture_revision_id: number | null;
  ux_revision_id: number | null;
  data_fingerprint: string;
  summary: string;
  flows: AppWireframeFlow[];
  screens: AppScreenWireframe[];
  tdd_cases: AppWireframeTestCase[];
  build_groups: AppBuildGroup[];
  tasks: AppBuildTask[];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const strings = (value: unknown): string[] => Array.isArray(value) ? value.map(text).filter(Boolean) : [];
const numberOrNull = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === 'string' && allowed.includes(value as T) ? value as T : fallback;

export function dataModelFingerprint(spec: AppSpec | null): string {
  const entities = (spec?.database.entities ?? []).map((entity) => ({
    name: entity.name,
    fields: entity.fields.map((field) => ({
      name: field.name,
      type: field.type,
      required: field.required === true,
      references: field.references ?? null,
    })),
  }));
  return createHash('sha256').update(JSON.stringify(entities)).digest('hex');
}

export function normalizeAppUxBrief(
  value: unknown,
  links: { specRevisionId: number | null; architectureRevisionId: number | null; dataFingerprint: string },
): AppUxBrief {
  const raw = record(value);
  const tokens = record(raw.tokens);
  const accessibility = record(raw.accessibility);
  return {
    v: 1,
    spec_revision_id: links.specRevisionId,
    architecture_revision_id: links.architectureRevisionId,
    data_fingerprint: links.dataFingerprint,
    summary: text(raw.summary),
    directions: (Array.isArray(raw.directions) ? raw.directions : []).map((item) => {
      const direction = record(item);
      return {
        id: text(direction.id),
        name: text(direction.name),
        rationale: text(direction.rationale),
        palette: strings(direction.palette),
        typography: text(direction.typography),
        density: oneOf(direction.density, ['compact', 'comfortable', 'spacious'] as const, 'comfortable'),
      };
    }),
    selected_direction_id: text(raw.selected_direction_id),
    tokens: {
      background: text(tokens.background), surface: text(tokens.surface), text: text(tokens.text), muted: text(tokens.muted),
      primary: text(tokens.primary), secondary: text(tokens.secondary), accent: text(tokens.accent), success: text(tokens.success),
      warning: text(tokens.warning), danger: text(tokens.danger), font_display: text(tokens.font_display), font_body: text(tokens.font_body),
      radius: text(tokens.radius), spacing: text(tokens.spacing),
      density: oneOf(tokens.density, ['compact', 'comfortable', 'spacious'] as const, 'comfortable'), motion: text(tokens.motion),
    },
    navigation: text(raw.navigation),
    principles: strings(raw.principles),
    constraints: strings(raw.constraints),
    rejected_directions: strings(raw.rejected_directions),
    accessibility: {
      standard: 'WCAG 2.2 AA',
      contrast: text(accessibility.contrast), keyboard: text(accessibility.keyboard), focus: text(accessibility.focus),
      reduced_motion: text(accessibility.reduced_motion),
    },
    references: (Array.isArray(raw.references) ? raw.references : []).map((item) => {
      const ref = record(item);
      return {
        kind: oneOf(ref.kind, ['image', 'url', 'design-system'] as const, 'image'),
        value: text(ref.value),
        note: text(ref.note),
      };
    }),
  };
}

export function parseAppUxBrief(raw: string | null | undefined): AppUxBrief | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as AppUxBrief;
    if (value?.v !== 1 || !Array.isArray(value.directions) || !value.tokens || !value.accessibility) return null;
    return normalizeAppUxBrief(value, {
      specRevisionId: numberOrNull(value.spec_revision_id),
      architectureRevisionId: numberOrNull(value.architecture_revision_id),
      dataFingerprint: text(value.data_fingerprint),
    });
  } catch { return null; }
}

export function normalizeAppWireframePlan(
  value: unknown,
  links: { specRevisionId: number | null; architectureRevisionId: number | null; uxRevisionId: number | null; dataFingerprint: string },
): AppWireframePlan {
  const raw = record(value);
  return {
    v: 1,
    spec_revision_id: links.specRevisionId,
    architecture_revision_id: links.architectureRevisionId,
    ux_revision_id: links.uxRevisionId,
    data_fingerprint: links.dataFingerprint,
    summary: text(raw.summary),
    flows: (Array.isArray(raw.flows) ? raw.flows : []).map((item) => {
      const flow = record(item);
      return {
        id: text(flow.id), name: text(flow.name), actor: text(flow.actor), goal: text(flow.goal),
        entry_screen_id: text(flow.entry_screen_id), source_ids: strings(flow.source_ids),
        steps: (Array.isArray(flow.steps) ? flow.steps : []).map((entry) => {
          const step = record(entry);
          return { id: text(step.id), screen_id: text(step.screen_id), action: text(step.action), result: text(step.result), reads: strings(step.reads), writes: strings(step.writes), next_step_ids: strings(step.next_step_ids) };
        }),
      };
    }),
    screens: (Array.isArray(raw.screens) ? raw.screens : []).map((item) => {
      const screen = record(item);
      return {
        screen_id: text(screen.screen_id), route: text(screen.route), flow_ids: strings(screen.flow_ids), hierarchy: strings(screen.hierarchy),
        regions: (Array.isArray(screen.regions) ? screen.regions : []).map((entry) => {
          const region = record(entry);
          return { id: text(region.id), purpose: text(region.purpose), components: strings(region.components) };
        }),
        actions: strings(screen.actions),
        data_bindings: (Array.isArray(screen.data_bindings) ? screen.data_bindings : []).map((entry) => {
          const binding = record(entry);
          return { entity: text(binding.entity), fields: strings(binding.fields), purpose: text(binding.purpose), fixture_scenario: text(binding.fixture_scenario) };
        }),
        states: (Array.isArray(screen.states) ? screen.states : []).map((state) => oneOf(state, ['loading', 'populated', 'empty', 'error', 'forbidden'] as const, 'populated')),
        responsive: text(screen.responsive), accessibility: strings(screen.accessibility),
      };
    }),
    tdd_cases: (Array.isArray(raw.tdd_cases) ? raw.tdd_cases : []).map((item) => {
      const testCase = record(item);
      return { id: text(testCase.id), title: text(testCase.title), architecture_case_ids: strings(testCase.architecture_case_ids), source_ids: strings(testCase.source_ids), flow_ids: strings(testCase.flow_ids), screen_ids: strings(testCase.screen_ids), preconditions: strings(testCase.preconditions), steps: strings(testCase.steps), expected: text(testCase.expected) };
    }),
    build_groups: (Array.isArray(raw.build_groups) ? raw.build_groups : []).map((item) => {
      const group = record(item);
      return { id: text(group.id), name: text(group.name), goal: text(group.goal), sequence: Number(group.sequence) || 0, complexity: oneOf(group.complexity, ['small', 'medium', 'large'] as const, 'medium'), flow_ids: strings(group.flow_ids), capability_ids: strings(group.capability_ids), screen_ids: strings(group.screen_ids), depends_on: strings(group.depends_on), task_ids: strings(group.task_ids) };
    }),
    tasks: (Array.isArray(raw.tasks) ? raw.tasks : []).map((item) => {
      const task = record(item);
      return { id: text(task.id), group_id: text(task.group_id), screen_id: text(task.screen_id) || null, kind: oneOf(task.kind, ['test-red', 'mock-contract', 'screen', 'responsive', 'accessibility', 'test-green', 'preview'] as const, 'screen'), title: text(task.title), sequence: Number(task.sequence) || 0, complexity: oneOf(task.complexity, ['small', 'medium', 'large'] as const, 'medium'), depends_on: strings(task.depends_on), tdd_case_ids: strings(task.tdd_case_ids), entity_names: strings(task.entity_names), source_ids: strings(task.source_ids) };
    }),
  };
}

export function parseAppWireframePlan(raw: string | null | undefined): AppWireframePlan | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as AppWireframePlan;
    if (value?.v !== 1 || !Array.isArray(value.flows) || !Array.isArray(value.screens) || !Array.isArray(value.tasks)) return null;
    return normalizeAppWireframePlan(value, {
      specRevisionId: numberOrNull(value.spec_revision_id), architectureRevisionId: numberOrNull(value.architecture_revision_id),
      uxRevisionId: numberOrNull(value.ux_revision_id), dataFingerprint: text(value.data_fingerprint),
    });
  } catch { return null; }
}

export function serializeExperienceArtifact(value: AppUxBrief | AppWireframePlan): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function architectureDesignCaseIds(plan: AppArchitecturePlan | null): string[] {
  return (plan?.tdd.cases ?? []).filter((testCase) => testCase.owner_stage === 'design').map((testCase) => testCase.id);
}
