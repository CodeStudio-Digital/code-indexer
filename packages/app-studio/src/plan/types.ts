import {
  validateAppPlanDocument,
  type AppPlanSchemaIssue,
} from './schema.js';

export const APP_PLAN_VERSION = 1 as const;

export type AppPlanRevisionStatus = 'draft' | 'approved' | 'superseded';
export type AppFitnessStatus = 'ready' | 'needs_decision' | 'blocked';
export type AppFitnessSeverity = 'info' | 'warning' | 'error';

export interface AppPlanSourceRef {
  id: string;
  kind: 'goal' | 'rule' | 'acceptance' | 'capability' | 'screen' | 'entity' | 'decision';
}

export interface AppPlanV1 {
  v: typeof APP_PLAN_VERSION;
  intent: {
    summary: string;
    audience: string;
    locale: string;
    goals: Array<{ id: string; text: string }>;
    out_of_scope: Array<{ id: string; text: string }>;
    assumptions: Array<{ id: string; text: string }>;
    risks: Array<{ id: string; text: string }>;
  };
  scope: {
    capabilities: Array<{
      id: string;
      name: string;
      description: string;
      selected: boolean;
      critical: boolean;
      quality_attributes: string[];
      source_ids: string[];
    }>;
    rules: Array<{ id: string; text: string; source_ids: string[] }>;
    acceptance: Array<{ id: string; text: string; capability_ids: string[] }>;
  };
  experience: {
    tone: string;
    primary_color?: string;
    navigation: string;
    screens: Array<{
      id: string;
      name: string;
      purpose: string;
      route: string;
      primary: boolean;
      protected: boolean;
      capability_ids: string[];
      states: string[];
    }>;
    flows: Array<{
      id: string;
      name: string;
      capability_ids: string[];
      steps: Array<{
        id: string;
        screen_id: string;
        action: string;
        reads: string[];
        writes: string[];
      }>;
    }>;
  };
  data: {
    required: boolean;
    auth: { enabled: boolean; methods: string[] };
    entities: Array<{
      id: string;
      name: string;
      label: string;
      fields: Array<{
        name: string;
        label: string;
        type: 'text' | 'integer' | 'real' | 'boolean' | 'timestamp' | 'json';
        required: boolean;
        unique: boolean;
        references?: string;
      }>;
    }>;
  };
  engineering: {
    stack_profile_id: 'cf-fullstack-v1';
    components: Array<{
      id: string;
      kind: 'spa' | 'worker' | 'd1' | 'cache' | 'queue' | 'object-storage' | 'durable-object';
      name: string;
      responsibility: string;
      consumer_ids: string[];
      source_ids: string[];
    }>;
    decisions: Array<{
      id: string;
      title: string;
      decision: string;
      rationale: string;
      source_ids: string[];
    }>;
    critical_writes: Array<{
      id: string;
      capability_id: string;
      entity: string;
      idempotency: string;
      consistency: string;
      constraint: string;
      test_id: string;
    }>;
    security: Array<{ id: string; control: string; source_ids: string[] }>;
  };
  delivery: {
    slices: Array<{
      id: string;
      name: string;
      capability_ids: string[];
      screen_ids: string[];
      entity_ids: string[];
      test_ids: string[];
      depends_on: string[];
    }>;
    tests: Array<{
      id: string;
      title: string;
      kind: 'database' | 'worker' | 'browser' | 'e2e';
      source_ids: string[];
      expected: string;
    }>;
  };
}

export interface AppFitnessCheck {
  id: string;
  status: 'pass' | 'fail';
  severity: AppFitnessSeverity;
  title: string;
  detail: string;
  source_ids: string[];
  action?: string;
}

export interface AppFitnessReport {
  v: 1;
  status: AppFitnessStatus;
  plan_fingerprint: string;
  checked_at: string;
  checks: AppFitnessCheck[];
  counts: { passed: number; warnings: number; errors: number };
}

export type AppPlanValidationResult =
  | { ok: true; plan: AppPlanV1 }
  | { ok: false; issues: AppPlanSchemaIssue[] };

export class AppPlanValidationError extends Error {
  readonly issues: AppPlanSchemaIssue[];

  constructor(issues: AppPlanSchemaIssue[]) {
    super(formatAppPlanValidationIssues(issues));
    this.name = 'AppPlanValidationError';
    this.issues = issues;
  }
}

export function emptyAppPlan(locale = 'pt-BR'): AppPlanV1 {
  return {
    v: APP_PLAN_VERSION,
    intent: {
      summary: '', audience: '', locale, goals: [], out_of_scope: [], assumptions: [], risks: [],
    },
    scope: { capabilities: [], rules: [], acceptance: [] },
    experience: { tone: '', navigation: '', screens: [], flows: [] },
    data: { required: false, auth: { enabled: false, methods: [] }, entities: [] },
    engineering: {
      stack_profile_id: 'cf-fullstack-v1', components: [], decisions: [], critical_writes: [], security: [],
    },
    delivery: { slices: [], tests: [] },
  };
}

export function validateAppPlan(value: string | unknown): AppPlanValidationResult {
  const result = validateAppPlanDocument(value);
  return result.ok
    ? { ok: true, plan: result.value as unknown as AppPlanV1 }
    : result;
}

export function formatAppPlanValidationIssues(issues: AppPlanSchemaIssue[], limit = 12): string {
  const visible = issues.slice(0, limit).map((issue) => `${issue.path} ${issue.message}`);
  const remainder = issues.length - visible.length;
  return `Invalid AppPlanV1: ${visible.join('; ')}${remainder > 0 ? `; and ${remainder} more issue(s)` : ''}`;
}

export function requireAppPlan(value: string | unknown): AppPlanV1 {
  const result = validateAppPlan(value);
  if (!result.ok) throw new AppPlanValidationError(result.issues);
  return result.plan;
}

export function parseAppPlan(value: string | unknown): AppPlanV1 | null {
  const result = validateAppPlan(value);
  return result.ok ? result.plan : null;
}
