import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppStudioSession, AppStudioStore } from '@mcp/store/app-studio-store.js';
import { emptyAppPlan } from '@mcp/app-studio/plan/types.js';
import { asSessionId } from '@mcp/session-storage';
import { appUpdatePlan } from '../app-workflow.js';
import { setAppStudioStore } from '../store-binding.js';

const SESSION = {
  id: asSessionId('11111111-1111-4111-8111-111111111111'),
} as unknown as AppStudioSession;
const BINDING = {
  resolveAppSession: async () => SESSION,
  describeBinding: () => `app_session_id=${SESSION.id}`,
};

describe('app_update_plan validation', () => {
  afterEach(() => setAppStudioStore(null));

  it('publishes the complete AppPlanV1 contract to the model', () => {
    const schema = appUpdatePlan(BINDING).parameters;
    const plan = schema.properties.plan as { properties?: Record<string, unknown>; required?: string[] };

    expect(plan.required).toEqual([
      'v', 'intent', 'scope', 'experience', 'data', 'engineering', 'delivery',
    ]);
    expect(plan.properties?.engineering).toBeDefined();
    expect(plan.properties?.delivery).toBeDefined();
  });

  it('returns path-based errors and never calls persistence for the crashing payload', async () => {
    const savePlanRevision = vi.fn();
    setAppStudioStore({ savePlanRevision } as unknown as AppStudioStore);
    const plan = emptyAppPlan() as unknown as Record<string, unknown>;
    plan.engineering = {
      ...(plan.engineering as Record<string, unknown>),
      components: [{ id: 'component:catalog', name: 'Catálogo persistente', description: 'Peças e módulos.' }],
    };
    plan.delivery = {
      slices: [{ id: 'slice:foundation', title: 'Fundação navegável' }],
      tests: [{ id: 'test:dimensions', name: 'Prévia dimensional' }],
    };

    const result = await appUpdatePlan(BINDING).handler(
      { plan, reason: 'Registrar o plano inicial.' },
      {} as never,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('plan.engineering.components[0].consumer_ids is required');
    expect(result.content).toContain('plan.delivery.slices[0].capability_ids is required');
    expect(result.content).not.toContain("Cannot read properties of undefined");
    expect(savePlanRevision).not.toHaveBeenCalled();
  });

  it('audits and persists a complete plan inside the guarded handler', async () => {
    const savePlanRevision = vi.fn(async () => ({
      id: '22222222-2222-4222-8222-222222222222',
      revision_number: 2,
    }));
    setAppStudioStore({ savePlanRevision } as unknown as AppStudioStore);
    const plan = emptyAppPlan();

    const result = await appUpdatePlan(BINDING).handler(
      { plan, reason: 'Salvar revisão completa.' },
      {} as never,
    );

    expect(result.isError).not.toBe(true);
    expect(savePlanRevision).toHaveBeenCalledWith(expect.objectContaining({
      app_session_id: SESSION.id,
      plan,
      expected_revision_number: null,
    }));
  });

  it('does not leak an unexpected TypeError from processing or persistence', async () => {
    setAppStudioStore({
      savePlanRevision: vi.fn(async () => {
        throw new TypeError("Cannot read properties of undefined (reading 'length')");
      }),
    } as unknown as AppStudioStore);

    const result = await appUpdatePlan(BINDING).handler(
      { plan: emptyAppPlan(), reason: 'Salvar revisão completa.' },
      {} as never,
    );

    expect(result).toMatchObject({
      isError: true,
      content: 'App plan processing failed after validation. No revision was saved.',
    });
  });
});
