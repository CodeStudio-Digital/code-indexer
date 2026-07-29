/**
 * C4 — plan-notification batching in HumanInTheLoop.
 *
 * Locks in the division of labor with the ApprovalBatcher:
 *   - the FIRST pending plan is notified immediately and verbatim (the
 *     pre-C4 path, byte-identical message);
 *   - a SECOND plan arriving while the first is still pending does NOT fire
 *     its own notify — one aggregated summary lands after the 5s window;
 *   - plans resolved during the window drop out of the summary;
 *   - clearAll cancels a pending summary.
 *
 * Only reachable with auto-approve OFF (session autonomy.autoApproveRoles=null).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HumanInTheLoop } from '../HumanInTheLoop.js';
import { resolveAutonomy } from '../autonomy/autonomy-config.js';

type PlanHandler = (block: { plan: string; toolUseId?: string }) => void;

const COMPANY_SESSION_ID = '00000000-0000-4000-8000-000000000001';
const MASTER_RUN_ID = '00000000-0000-4000-8000-000000000010';
const BACKEND_RUN_ID = '00000000-0000-4000-8000-000000000012';
const FRONTEND_RUN_ID = '00000000-0000-4000-8000-000000000013';
const QA_RUN_ID = '00000000-0000-4000-8000-000000000014';

const autonomyOff = {
  get: () => resolveAutonomy(JSON.stringify({ autonomy: { autoApproveRoles: null } }), {}),
};

function makeHarness() {
  const handlers = new Map<string, PlanHandler>();
  const masterNotify = vi.fn();
  const interruptWait = vi.fn();
  const signal = vi.fn();

  const bus = { publish: vi.fn(), markEnded: vi.fn(), bus: {} } as never;
  const board = { post: vi.fn() } as never;
  const status = { setStatus: vi.fn(), publishStatus: vi.fn() } as never;
  const master = {
    notify: masterNotify,
    handle: { runner: { interruptWait } },
    agentRunId: MASTER_RUN_ID,
  } as never;
  const attention = { signal, on: () => () => {} } as never;
  const ctx = { companySessionId: COMPANY_SESSION_ID } as never;

  const hitl = new HumanInTheLoop(bus, board, status, master, attention, ctx, autonomyOff);

  const wire = (agentRunId: string, role: string): void => {
    const runner = {
      on: (event: string, cb: PlanHandler) => {
        if (event === 'plan_posted') handlers.set(agentRunId, cb);
      },
      provideUserInput: vi.fn(),
    };
    hitl.wireSubordinatePlan({ runner } as never, agentRunId, role);
  };

  return {
    hitl,
    wire,
    fire: (agentRunId: string, plan: string) =>
      handlers.get(agentRunId)?.({ plan }),
    masterNotify,
    interruptWait,
    signal,
  };
}

describe('HumanInTheLoop — C4 plan-notification batching', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('single plan: immediate verbatim notify (pre-C4 path untouched)', () => {
    const h = makeHarness();
    h.wire(BACKEND_RUN_ID, 'backend');
    h.fire(BACKEND_RUN_ID, '1. add auth API');

    expect(h.masterNotify).toHaveBeenCalledTimes(1);
    expect(h.masterNotify.mock.calls[0][0]).toContain(
      `@backend (agent_run_id=${BACKEND_RUN_ID}) submitted a plan for approval and is BLOCKED.`,
    );
    expect(h.signal).toHaveBeenCalledWith({
      kind: 'plan',
      agentRunId: BACKEND_RUN_ID,
      role: 'backend',
    });
    // No pending summary window: advancing time adds nothing.
    vi.advanceTimersByTime(10_000);
    expect(h.masterNotify).toHaveBeenCalledTimes(1);
  });

  it('burst of plans: first immediate, the rest collapse into ONE summary', () => {
    const h = makeHarness();
    h.wire(BACKEND_RUN_ID, 'backend');
    h.wire(FRONTEND_RUN_ID, 'frontend');
    h.wire(QA_RUN_ID, 'qa');

    h.fire(BACKEND_RUN_ID, '1. add auth API');
    h.fire(FRONTEND_RUN_ID, '1. build login form');
    h.fire(QA_RUN_ID, '1. write e2e specs');

    // Only the first plan notified so far.
    expect(h.masterNotify).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5_000);

    expect(h.masterNotify).toHaveBeenCalledTimes(2);
    const summary = h.masterNotify.mock.calls[1][0] as string;
    expect(summary).toContain('3 subordinate plans are awaiting your approval');
    expect(summary).toContain(`@backend (agent_run_id=${BACKEND_RUN_ID})`);
    expect(summary).toContain(`@frontend (agent_run_id=${FRONTEND_RUN_ID})`);
    expect(summary).toContain(`@qa (agent_run_id=${QA_RUN_ID})`);
    expect(summary).toContain('approve_subordinate_plans');
    // Wake signals re-fired for every pending plan on flush.
    expect(h.signal).toHaveBeenCalledWith({
      kind: 'plan',
      agentRunId: FRONTEND_RUN_ID,
      role: 'frontend',
    });
    expect(h.signal).toHaveBeenCalledWith({
      kind: 'plan',
      agentRunId: QA_RUN_ID,
      role: 'qa',
    });
  });

  it('plans resolved inside the window drop out — lone survivor gets the classic message', () => {
    const h = makeHarness();
    h.wire(BACKEND_RUN_ID, 'backend');
    h.wire(FRONTEND_RUN_ID, 'frontend');

    h.fire(BACKEND_RUN_ID, '1. add auth API');
    h.fire(FRONTEND_RUN_ID, '1. build login form');
    expect(h.masterNotify).toHaveBeenCalledTimes(1);

    // The master resolves #12 before the window elapses.
    expect(h.hitl.resolvePlan(BACKEND_RUN_ID, true)).toBe(true);
    vi.advanceTimersByTime(5_000);

    expect(h.masterNotify).toHaveBeenCalledTimes(2);
    const second = h.masterNotify.mock.calls[1][0] as string;
    expect(second).toContain(
      `@frontend (agent_run_id=${FRONTEND_RUN_ID}) submitted a plan for approval`,
    );
    expect(second).not.toContain('plans are awaiting');
  });

  it('clearAll cancels a pending summary (no stale notify after abort)', () => {
    const h = makeHarness();
    h.wire(BACKEND_RUN_ID, 'backend');
    h.wire(FRONTEND_RUN_ID, 'frontend');
    h.fire(BACKEND_RUN_ID, '1. one');
    h.fire(FRONTEND_RUN_ID, '1. two');
    expect(h.masterNotify).toHaveBeenCalledTimes(1);

    h.hitl.clearAll();
    vi.advanceTimersByTime(10_000);
    expect(h.masterNotify).toHaveBeenCalledTimes(1);
  });
});
