import type { AppStageId } from '../pipeline/stages.js';
import { APP_STACK_PROFILE_ID } from './stack-profile.js';

export { APP_STACK_PROFILE_ID } from './stack-profile.js';

export const APP_ARCHITECTURE_SOURCE_DOMAINS = [
  'developers.cloudflare.com',
  'react.dev',
  'vite.dev',
  'hono.dev',
  'vitest.dev',
  'playwright.dev',
  'better-auth.com',
] as const;

export type AppArchitectureLayer = 'ui' | 'worker' | 'data' | 'cross-cutting';
export type AppTestLayer = 'database' | 'worker' | 'browser' | 'e2e';
export type AppTestOwnerStage = Extract<AppStageId, 'database' | 'design' | 'backend' | 'review'>;

export interface AppArchitectureSource {
  title: string;
  url: string;
  checked_at: string;
  notes: string;
}

export interface AppArchitectureDecision {
  id: string;
  title: string;
  decision: string;
  rationale: string;
  source_urls: string[];
}

export interface AppArchitectureModule {
  id: string;
  name: string;
  layer: AppArchitectureLayer;
  responsibility: string;
  depends_on: string[];
}

export interface AppArchitectureRisk {
  id: string;
  title: string;
  mitigation: string;
  severity: 'low' | 'medium' | 'high';
}

export interface AppTddCase {
  id: string;
  title: string;
  layer: AppTestLayer;
  owner_stage: AppTestOwnerStage;
  priority: 'critical' | 'important' | 'supporting';
  source_ids: string[];
  preconditions: string[];
  steps: string[];
  expected: string;
}

export interface AppTddSpec {
  strategy: string;
  cases: AppTddCase[];
}

export interface AppArchitecturePlan {
  v: 1;
  spec_revision_id: number | null;
  stack_profile_id: typeof APP_STACK_PROFILE_ID;
  summary: string;
  modules: AppArchitectureModule[];
  decisions: AppArchitectureDecision[];
  data_flow: string[];
  security: string[];
  observability: string[];
  risks: AppArchitectureRisk[];
  sources: AppArchitectureSource[];
  tdd: AppTddSpec;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && allowed.includes(value as T) ? value as T : fallback;
}

/**
 * Provider tool calls often omit optional arrays or enum defaults. Normalize
 * that recoverable variation before validation so the audit returns concrete
 * issues instead of throwing on `undefined` collections.
 */
export function normalizeAppArchitecturePlan(value: unknown, specRevisionId: number | null): AppArchitecturePlan {
  const raw = record(value);
  const tdd = record(raw.tdd);
  return {
    v: 1,
    spec_revision_id: specRevisionId,
    stack_profile_id: APP_STACK_PROFILE_ID,
    summary: text(raw.summary),
    modules: (Array.isArray(raw.modules) ? raw.modules : []).map((item) => {
      const module = record(item);
      return {
        id: text(module.id),
        name: text(module.name),
        layer: oneOf(module.layer, ['ui', 'worker', 'data', 'cross-cutting'] as const, 'cross-cutting'),
        responsibility: text(module.responsibility),
        depends_on: strings(module.depends_on),
      };
    }),
    decisions: (Array.isArray(raw.decisions) ? raw.decisions : []).map((item) => {
      const decision = record(item);
      return {
        id: text(decision.id),
        title: text(decision.title),
        decision: text(decision.decision),
        rationale: text(decision.rationale),
        source_urls: strings(decision.source_urls),
      };
    }),
    data_flow: strings(raw.data_flow),
    security: strings(raw.security),
    observability: strings(raw.observability),
    risks: (Array.isArray(raw.risks) ? raw.risks : []).map((item) => {
      const risk = record(item);
      return {
        id: text(risk.id),
        title: text(risk.title),
        mitigation: text(risk.mitigation),
        severity: oneOf(risk.severity, ['low', 'medium', 'high'] as const, 'medium'),
      };
    }),
    sources: (Array.isArray(raw.sources) ? raw.sources : []).map((item) => {
      const source = record(item);
      return {
        title: text(source.title),
        url: text(source.url),
        checked_at: text(source.checked_at),
        notes: text(source.notes),
      };
    }),
    tdd: {
      strategy: text(tdd.strategy),
      cases: (Array.isArray(tdd.cases) ? tdd.cases : []).map((item) => {
        const testCase = record(item);
        return {
          id: text(testCase.id),
          title: text(testCase.title),
          layer: oneOf(testCase.layer, ['database', 'worker', 'browser', 'e2e'] as const, 'worker'),
          owner_stage: oneOf(testCase.owner_stage, ['database', 'design', 'backend', 'review'] as const, 'backend'),
          priority: oneOf(testCase.priority, ['critical', 'important', 'supporting'] as const, 'important'),
          source_ids: strings(testCase.source_ids),
          preconditions: strings(testCase.preconditions),
          steps: strings(testCase.steps),
          expected: text(testCase.expected),
        };
      }),
    },
  };
}

export function parseAppArchitecturePlan(raw: string | null | undefined): AppArchitecturePlan | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as AppArchitecturePlan;
    if (
      value?.v !== 1 ||
      value.stack_profile_id !== APP_STACK_PROFILE_ID ||
      !Array.isArray(value.modules) ||
      !Array.isArray(value.decisions) ||
      !Array.isArray(value.data_flow) ||
      !Array.isArray(value.security) ||
      !Array.isArray(value.observability) ||
      !Array.isArray(value.risks) ||
      !Array.isArray(value.sources) ||
      !Array.isArray(value.tdd?.cases)
    ) {
      return null;
    }
    return normalizeAppArchitecturePlan(value, typeof value.spec_revision_id === 'number' ? value.spec_revision_id : null);
  } catch {
    return null;
  }
}

export function serializeAppArchitecturePlan(plan: AppArchitecturePlan): string {
  return JSON.stringify(plan, null, 2) + '\n';
}
