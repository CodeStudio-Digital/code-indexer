/**
 * Tests for the Phase 3 fast-path plan auto-approval in HumanInTheLoop.
 * A trusted role (per MCP_COMPANY_AUTO_APPROVE_ROLES) gets its plan approved
 * immediately — no pending registration, no master round-trip.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HumanInTheLoop } from '../HumanInTheLoop.js';

type PlanHandler = (block: { plan: string; toolUseId?: string }) => void;

function makeHarness() {
  let planHandler: PlanHandler | null = null;
  const provideUserInput = vi.fn();
  const runner = {
    on: (event: string, cb: PlanHandler) => { if (event === 'plan_posted') planHandler = cb; },
    provideUserInput,
  };
  const handle = { runner } as never;

  const bus = { publish: vi.fn(), markEnded: vi.fn(), bus: {} } as never;
  const board = { post: vi.fn() } as never;
  const status = { setStatus: vi.fn(), publishStatus: vi.fn() } as never;
  const masterNotify = vi.fn();
  const master = { notify: masterNotify, handle: null, agentRunId: 1 } as never;
  const attention = { signal: vi.fn(), on: () => () => {} } as never;
  const ctx = { companySessionId: 1 } as never;

  const hitl = new HumanInTheLoop(bus, board, status, master, attention, ctx);
  hitl.wireSubordinatePlan(handle, 42, 'frontend');
  return {
    fire: (plan: string) => planHandler?.({ plan }),
    provideUserInput,
    masterNotify,
    hasPendingPlan: () => hitl.hasPendingPlan(42),
  };
}

describe('HumanInTheLoop plan auto-approval', () => {
  const original = process.env.MCP_COMPANY_AUTO_APPROVE_ROLES;
  beforeEach(() => { delete process.env.MCP_COMPANY_AUTO_APPROVE_ROLES; });
  afterEach(() => {
    if (original === undefined) delete process.env.MCP_COMPANY_AUTO_APPROVE_ROLES;
    else process.env.MCP_COMPANY_AUTO_APPROVE_ROLES = original;
  });

  it('auto-approves a trusted role without notifying the master', () => {
    process.env.MCP_COMPANY_AUTO_APPROVE_ROLES = 'frontend,backend';
    const h = makeHarness();
    h.fire('1. do the thing');
    expect(h.provideUserInput).toHaveBeenCalledTimes(1);
    const arg = JSON.parse(h.provideUserInput.mock.calls[0][0] as string);
    expect(arg.approved).toBe(true);
    expect(h.masterNotify).not.toHaveBeenCalled();
    expect(h.hasPendingPlan()).toBe(false);
  });

  it('"*" auto-approves every role', () => {
    process.env.MCP_COMPANY_AUTO_APPROVE_ROLES = '*';
    const h = makeHarness();
    h.fire('1. ship it');
    expect(h.provideUserInput).toHaveBeenCalledTimes(1);
    expect(h.masterNotify).not.toHaveBeenCalled();
  });

  it('does NOT auto-approve a role outside the allowlist — blocks on the master', () => {
    process.env.MCP_COMPANY_AUTO_APPROVE_ROLES = 'backend';
    const h = makeHarness(); // role is 'frontend'
    h.fire('1. needs review');
    expect(h.provideUserInput).not.toHaveBeenCalled();
    expect(h.masterNotify).toHaveBeenCalledTimes(1);
    expect(h.hasPendingPlan()).toBe(true);
  });

  it('is OFF by default (env unset) — blocks on the master', () => {
    const h = makeHarness();
    h.fire('1. default path');
    expect(h.provideUserInput).not.toHaveBeenCalled();
    expect(h.masterNotify).toHaveBeenCalledTimes(1);
  });
});
