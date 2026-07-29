/**
 * Tests for the fast-path plan auto-approval in HumanInTheLoop.
 * C2 — resolved through the per-session autonomy config: default '*'
 * (every role self-approves); a PRESENT env overrides (empty = off);
 * the session's `autonomy.autoApproveRoles` overrides everything and
 * `freeze` never auto-approves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HumanInTheLoop } from '../HumanInTheLoop.js';
import { resolveAutonomy } from '../autonomy/autonomy-config.js';

type PlanHandler = (block: { plan: string; toolUseId?: string }) => void;

const COMPANY_SESSION_ID = '00000000-0000-4000-8000-000000000001';
const MASTER_RUN_ID = '00000000-0000-4000-8000-000000000010';
const FRONTEND_RUN_ID = '00000000-0000-4000-8000-000000000042';

/** Fake per-session autonomy provider over a session `autonomy` object. */
function fakeAutonomy(autonomy: Record<string, unknown>, env: NodeJS.ProcessEnv = {}) {
  return { get: () => resolveAutonomy(JSON.stringify({ autonomy }), env) };
}

function makeHarness(autonomy?: { get: () => ReturnType<typeof resolveAutonomy> }) {
  let planHandler: PlanHandler | null = null;
  const provideUserInput = vi.fn();
  const runner = {
    on: (event: string, cb: PlanHandler) => { if (event === 'plan_posted') planHandler = cb; },
    provideUserInput,
  };
  const handle = { runner } as never;

  const busPublish = vi.fn();
  const bus = { publish: busPublish, markEnded: vi.fn(), bus: {} } as never;
  const board = { post: vi.fn() } as never;
  const status = { setStatus: vi.fn(), publishStatus: vi.fn() } as never;
  const masterNotify = vi.fn();
  const master = {
    notify: masterNotify,
    handle: null,
    agentRunId: MASTER_RUN_ID,
  } as never;
  const attention = { signal: vi.fn(), on: () => () => {} } as never;
  const ctx = { companySessionId: COMPANY_SESSION_ID } as never;

  const hitl = new HumanInTheLoop(bus, board, status, master, attention, ctx, autonomy);
  hitl.wireSubordinatePlan(handle, FRONTEND_RUN_ID, 'frontend');
  return {
    fire: (plan: string) => planHandler?.({ plan }),
    provideUserInput,
    masterNotify,
    busPublish,
    hasPendingPlan: () => hitl.hasPendingPlan(FRONTEND_RUN_ID),
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
    // C1 — a dedicated visibility event rides the session metaBus.
    expect(h.busPublish).toHaveBeenCalledWith(
      'plan_auto_approved',
      expect.objectContaining({
        agentRunId: FRONTEND_RUN_ID,
        role: 'frontend',
        at: expect.any(Number),
      }),
    );
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
    // No auto-approve → no visibility event.
    expect(h.busPublish).not.toHaveBeenCalledWith('plan_auto_approved', expect.anything());
  });

  it('C2 — is ON by default (env unset, no provider): every role self-approves', () => {
    const h = makeHarness();
    h.fire('1. default path');
    expect(h.provideUserInput).toHaveBeenCalledTimes(1);
    const arg = JSON.parse(h.provideUserInput.mock.calls[0][0] as string);
    expect(arg.approved).toBe(true);
    expect(h.masterNotify).not.toHaveBeenCalled();
  });

  it('C2 — an EXPLICIT empty env turns it OFF (presence overrides the default)', () => {
    process.env.MCP_COMPANY_AUTO_APPROVE_ROLES = '';
    const h = makeHarness();
    h.fire('1. env said nobody');
    expect(h.provideUserInput).not.toHaveBeenCalled();
    expect(h.masterNotify).toHaveBeenCalledTimes(1);
    expect(h.hasPendingPlan()).toBe(true);
  });

  it('C2 — session allowlist (provider) overrides the env: env excludes, session includes', () => {
    const h = makeHarness(fakeAutonomy(
      { autoApproveRoles: ['frontend'] },
      { MCP_COMPANY_AUTO_APPROVE_ROLES: 'backend' },
    ));
    h.fire('1. session trusts me');
    expect(h.provideUserInput).toHaveBeenCalledTimes(1);
    expect(h.masterNotify).not.toHaveBeenCalled();
  });

  it('C2 — session explicit null (provider) turns it OFF even though the default is "*"', () => {
    const h = makeHarness(fakeAutonomy({ autoApproveRoles: null }));
    h.fire('1. session said nobody');
    expect(h.provideUserInput).not.toHaveBeenCalled();
    expect(h.masterNotify).toHaveBeenCalledTimes(1);
  });

  it('C2 — freeze NEVER auto-approves, whatever the role list says', () => {
    const h = makeHarness(fakeAutonomy({ autoApproveRoles: '*', freeze: true }));
    h.fire('1. frozen session');
    expect(h.provideUserInput).not.toHaveBeenCalled();
    expect(h.masterNotify).toHaveBeenCalledTimes(1);
    expect(h.busPublish).not.toHaveBeenCalledWith('plan_auto_approved', expect.anything());
  });
});
