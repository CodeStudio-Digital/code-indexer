/**
 * B7 — tests for the `approvedPlans` registry consumed by the QA plan
 * gate: fed by BOTH approval paths (manual `resolvePlan` and the
 * autonomy fast-path), invalidated by re-posting/rejection, and cleared
 * on `clearForAgent`/`clearAll` (abort, pause, finalize).
 */
import { describe, expect, it, vi } from 'vitest';
import { HumanInTheLoop } from '../HumanInTheLoop.js';
import { resolveAutonomy } from '../autonomy/autonomy-config.js';

type PlanHandler = (block: { plan: string; toolUseId?: string }) => void;

function fakeAutonomy(autonomy: Record<string, unknown>) {
  return { get: () => resolveAutonomy(JSON.stringify({ autonomy }), {}) };
}

function makeHarness(autonomy: { get: () => ReturnType<typeof resolveAutonomy> }) {
  let planHandler: PlanHandler | null = null;
  const runner = {
    on: (event: string, cb: PlanHandler) => { if (event === 'plan_posted') planHandler = cb; },
    provideUserInput: vi.fn(),
  };
  const handle = { runner } as never;
  const bus = { publish: vi.fn(), markEnded: vi.fn(), bus: {} } as never;
  const board = { post: vi.fn() } as never;
  const status = { setStatus: vi.fn(), publishStatus: vi.fn() } as never;
  const master = { notify: vi.fn(), handle: null, agentRunId: 1 } as never;
  const attention = { signal: vi.fn(), on: () => () => {} } as never;
  const ctx = { companySessionId: 1 } as never;

  const hitl = new HumanInTheLoop(bus, board, status, master, attention, ctx, autonomy);
  hitl.wireSubordinatePlan(handle, 42, 'qa');
  return { hitl, fire: (plan: string) => planHandler?.({ plan }) };
}

const AUTO_ON = fakeAutonomy({ autoApproveRoles: '*' });
const AUTO_OFF = fakeAutonomy({ autoApproveRoles: null });

describe('HumanInTheLoop.approvedPlans', () => {
  it('starts empty — hasApprovedPlan is null before any plan', () => {
    const { hitl } = makeHarness(AUTO_OFF);
    expect(hitl.hasApprovedPlan(42)).toBeNull();
  });

  it('fast-path auto-approve registers auto=true', () => {
    const { hitl, fire } = makeHarness(AUTO_ON);
    fire('1. test the login flow');
    expect(hitl.hasApprovedPlan(42)).toEqual({ approved: true, auto: true });
  });

  it('manual resolvePlan(approved=true) registers auto=false', () => {
    const { hitl, fire } = makeHarness(AUTO_OFF);
    fire('1. test the login flow');
    expect(hitl.hasApprovedPlan(42)).toBeNull(); // pending, not approved
    expect(hitl.resolvePlan(42, true, 'lgtm')).toBe(true);
    expect(hitl.hasApprovedPlan(42)).toEqual({ approved: true, auto: false });
  });

  it('rejection clears any approval', () => {
    const { hitl, fire } = makeHarness(AUTO_OFF);
    fire('plan v1');
    hitl.resolvePlan(42, true);
    fire('plan v2'); // re-plan → pending again
    expect(hitl.hasApprovedPlan(42)).toBeNull();
    hitl.resolvePlan(42, false, 'not enough coverage');
    expect(hitl.hasApprovedPlan(42)).toBeNull();
  });

  it('a newly POSTED plan invalidates the previous approval', () => {
    const { hitl, fire } = makeHarness(AUTO_OFF);
    fire('plan v1');
    hitl.resolvePlan(42, true);
    expect(hitl.hasApprovedPlan(42)).not.toBeNull();
    fire('plan v2');
    expect(hitl.hasApprovedPlan(42)).toBeNull();
  });

  it('clearForAgent wipes the approval (abort/pause teardown)', () => {
    const { hitl, fire } = makeHarness(AUTO_ON);
    fire('plan');
    expect(hitl.hasApprovedPlan(42)).not.toBeNull();
    hitl.clearForAgent(42);
    expect(hitl.hasApprovedPlan(42)).toBeNull();
  });

  it('clearAll wipes every approval (finalize)', () => {
    const { hitl, fire } = makeHarness(AUTO_ON);
    fire('plan');
    hitl.clearAll();
    expect(hitl.hasApprovedPlan(42)).toBeNull();
  });

  it('is per-agent — other run ids stay null', () => {
    const { hitl, fire } = makeHarness(AUTO_ON);
    fire('plan');
    expect(hitl.hasApprovedPlan(43)).toBeNull();
  });
});
