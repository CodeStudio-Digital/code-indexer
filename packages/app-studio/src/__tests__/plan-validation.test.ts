import { describe, expect, it } from 'vitest';
import { auditAppPlan } from '../plan/fitness.js';
import { APP_PLAN_SCHEMA } from '../plan/schema.js';
import {
  AppPlanValidationError,
  emptyAppPlan,
  parseAppPlan,
  requireAppPlan,
  validateAppPlan,
} from '../plan/types.js';

function simplifiedLegacyPlan() {
  return {
    ...emptyAppPlan(),
    engineering: {
      ...emptyAppPlan().engineering,
      components: [{
        id: 'component:catalog',
        name: 'Catálogo persistente',
        description: 'Peças e módulos reutilizáveis.',
      }],
    },
    delivery: {
      slices: [{
        id: 'slice:foundation',
        title: 'Fundação navegável',
        description: 'Biblioteca, Ambiente e Orçamento.',
      }],
      tests: [{
        id: 'test:dimensions',
        name: 'Prévia dimensional',
        description: 'Valida fórmulas paramétricas.',
      }],
    },
  };
}

describe('AppPlanV1 structural validation', () => {
  it('uses the full canonical schema for complete plans', () => {
    const plan = emptyAppPlan();
    expect(validateAppPlan(plan)).toEqual({ ok: true, plan });
    expect(parseAppPlan(JSON.stringify(plan))).toEqual(plan);
    expect(APP_PLAN_SCHEMA.required).toEqual([
      'v', 'intent', 'scope', 'experience', 'data', 'engineering', 'delivery',
    ]);
  });

  it('reports actionable paths for the simplified payload that crashed the audit', () => {
    const result = validateAppPlan(simplifiedLegacyPlan());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual(expect.arrayContaining([
      { path: 'plan.engineering.components[0].kind', message: 'is required' },
      { path: 'plan.engineering.components[0].consumer_ids', message: 'is required' },
      { path: 'plan.delivery.slices[0].capability_ids', message: 'is required' },
      { path: 'plan.delivery.tests[0].kind', message: 'is required' },
    ]));
    expect(parseAppPlan(simplifiedLegacyPlan())).toBeNull();
  });

  it('makes the audit boundary fail with validation details instead of a TypeError', () => {
    const invalid = simplifiedLegacyPlan();

    expect(() => requireAppPlan(invalid)).toThrow(AppPlanValidationError);
    expect(() => auditAppPlan(invalid)).toThrow(
      /plan\.engineering\.components\[0\]\.consumer_ids is required/,
    );
  });
});
