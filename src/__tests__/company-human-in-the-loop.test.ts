import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HumanInTheLoop } from '@mcp/company/services/HumanInTheLoop.js';
import type { MasterPrompt } from '@mcp/company-contracts';

function masterPrompt(overrides: Partial<MasterPrompt> = {}): MasterPrompt {
  return {
    id: 1,
    company_session_id: 42,
    agent_run_id: 100,
    kind: 'plan',
    runner_block_id: null,
    body: 'plan body',
    options: null,
    allow_freeform: true,
    status: 'answered',
    answer: null,
    approved: true,
    feedback: '',
    created_at: '2025-01-01',
    resolved_at: '2025-01-01',
    ...overrides,
  };
}

interface Harness {
  hitl: HumanInTheLoop;
  bus: { publish: ReturnType<typeof vi.fn>; markEnded: ReturnType<typeof vi.fn> };
  board: { post: ReturnType<typeof vi.fn>; read: ReturnType<typeof vi.fn>; lastMasterSeenId: number; advanceMasterWatermark: ReturnType<typeof vi.fn> };
  status: { setStatus: ReturnType<typeof vi.fn> };
  store: {
    resolveMasterPrompt: ReturnType<typeof vi.fn>;
    getPendingMasterPrompt: ReturnType<typeof vi.fn>;
    cancelPendingMasterPrompts: ReturnType<typeof vi.fn>;
    createMasterPrompt: ReturnType<typeof vi.fn>;
  };
  master: {
    handle: { runner: { provideUserInput: ReturnType<typeof vi.fn>; interruptWait: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> } } | null;
    agentRunId: number | null;
    isAlive: boolean;
    endedWithError: string | null;
    notify: ReturnType<typeof vi.fn>;
    setShouldContinue: ReturnType<typeof vi.fn>;
  };
  attention: { signal: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn>; emit: ReturnType<typeof vi.fn> };
}

function makeHarness(opts: { masterAlive?: boolean } = {}): Harness {
  const provideUserInput = vi.fn().mockReturnValue(true);
  const interruptWait = vi.fn();
  const runnerOn = vi.fn();
  const handle = opts.masterAlive === false
    ? null
    : { runner: { provideUserInput, interruptWait, on: runnerOn } };

  const bus = { publish: vi.fn(), markEnded: vi.fn() };
  const board = {
    post: vi.fn(),
    read: vi.fn(() => []),
    lastMasterSeenId: 0,
    advanceMasterWatermark: vi.fn(),
  };
  const status = { setStatus: vi.fn() };
  const store = {
    resolveMasterPrompt: vi.fn(),
    getPendingMasterPrompt: vi.fn(() => null),
    cancelPendingMasterPrompts: vi.fn(() => []),
    createMasterPrompt: vi.fn(),
  };
  const master = {
    handle: handle as Harness['master']['handle'],
    agentRunId: 100,
    isAlive: handle != null,
    endedWithError: null,
    notify: vi.fn(),
    setShouldContinue: vi.fn(),
  };
  const attention = { signal: vi.fn(), on: vi.fn(), emit: vi.fn() };

  const ctx = {
    companySessionId: 42,
    companyStore: store as never,
  } as never;

  const hitl = new HumanInTheLoop(
    bus as never,
    board as never,
    status as never,
    master as never,
    attention as never,
    ctx,
  );
  return { hitl, bus, board, status, store, master, attention };
}

describe('HumanInTheLoop — master plan', () => {
  let h: Harness;
  beforeEach(() => { h = makeHarness(); });

  it('returns null when the master handle is gone', () => {
    const h2 = makeHarness({ masterAlive: false });
    expect(h2.hitl.respondToMasterPlan(true)).toBeNull();
    expect(h2.store.resolveMasterPrompt).not.toHaveBeenCalled();
  });

  it('returns null when there is no pending prompt id available', () => {
    h.store.getPendingMasterPrompt.mockReturnValueOnce(null);
    expect(h.hitl.respondToMasterPlan(true)).toBeNull();
  });

  it('returns null when resolveMasterPrompt reports already-resolved', () => {
    h.store.getPendingMasterPrompt.mockReturnValueOnce({ id: 7 });
    h.store.resolveMasterPrompt.mockReturnValueOnce(null);
    expect(h.hitl.respondToMasterPlan(true)).toBeNull();
  });

  it('resolves with explicit promptId, sends to runner, sets running status, posts decision', () => {
    const resolved = masterPrompt({ id: 7, status: 'answered', approved: true });
    h.store.resolveMasterPrompt.mockReturnValueOnce(resolved);
    const result = h.hitl.respondToMasterPlan(true, 'lgtm', 7);
    expect(result).toBe(resolved);
    expect(h.store.resolveMasterPrompt).toHaveBeenCalledWith(7, {
      kind: 'plan', approved: true, feedback: 'lgtm',
    });
    expect(h.master.handle!.runner.provideUserInput).toHaveBeenCalledWith(
      JSON.stringify({ approved: true, feedback: 'lgtm' }),
    );
    expect(h.master.setShouldContinue).toHaveBeenCalledWith(true);
    expect(h.status.setStatus).toHaveBeenCalledWith(100, 'running');
    expect(h.board.post).toHaveBeenCalledWith('human', null, 'decision', 'Plan APPROVED: lgtm');
    expect(h.bus.publish).toHaveBeenCalledWith('master_plan_resolved', { prompt: resolved });
  });

  it('falls back to getPendingMasterPrompt when no promptId is supplied', () => {
    const resolved = masterPrompt({ id: 9 });
    h.store.getPendingMasterPrompt.mockReturnValueOnce({ id: 9 });
    h.store.resolveMasterPrompt.mockReturnValueOnce(resolved);
    h.hitl.respondToMasterPlan(false);
    expect(h.store.getPendingMasterPrompt).toHaveBeenCalledWith(42, 'plan');
    expect(h.store.resolveMasterPrompt).toHaveBeenCalledWith(9, {
      kind: 'plan', approved: false, feedback: undefined,
    });
  });

  it('encodes REJECTED decisions for the board', () => {
    h.store.getPendingMasterPrompt.mockReturnValueOnce({ id: 1 });
    h.store.resolveMasterPrompt.mockReturnValueOnce(masterPrompt({ id: 1, approved: false }));
    h.hitl.respondToMasterPlan(false);
    expect(h.board.post).toHaveBeenCalledWith('human', null, 'decision', 'Plan REJECTED');
  });

  it('consumeMasterShouldContinue returns true exactly once after a plan resolution', () => {
    h.store.getPendingMasterPrompt.mockReturnValueOnce({ id: 1 });
    h.store.resolveMasterPrompt.mockReturnValueOnce(masterPrompt({ id: 1 }));
    h.hitl.respondToMasterPlan(true);
    expect(h.hitl.consumeMasterShouldContinue()).toBe(true);
    expect(h.hitl.consumeMasterShouldContinue()).toBe(false);
  });
});

describe('HumanInTheLoop — master question', () => {
  let h: Harness;
  beforeEach(() => { h = makeHarness(); });

  it('returns null when no handle', () => {
    const h2 = makeHarness({ masterAlive: false });
    expect(h2.hitl.respondToMasterQuestion('hi')).toBeNull();
  });

  it('resolves and publishes master_question_resolved', () => {
    const resolved = masterPrompt({ id: 3, kind: 'question', answer: 'yes' });
    h.store.resolveMasterPrompt.mockReturnValueOnce(resolved);
    const out = h.hitl.respondToMasterQuestion('yes', 3);
    expect(out).toBe(resolved);
    expect(h.store.resolveMasterPrompt).toHaveBeenCalledWith(3, {
      kind: 'question', answer: 'yes',
    });
    expect(h.master.handle!.runner.provideUserInput).toHaveBeenCalledWith(
      JSON.stringify({ answer: 'yes' }),
    );
    expect(h.board.post).toHaveBeenCalledWith('human', null, 'decision', 'Human answered: yes');
    expect(h.bus.publish).toHaveBeenCalledWith('master_question_resolved', { prompt: resolved });
  });
});

describe('HumanInTheLoop — cancelPendingMasterPrompts', () => {
  let h: Harness;
  beforeEach(() => { h = makeHarness(); });

  it('publishes cancellation events for every prompt', () => {
    const cancelled = [
      masterPrompt({ id: 1, status: 'cancelled' }),
      masterPrompt({ id: 2, status: 'cancelled', kind: 'question' }),
    ];
    h.store.cancelPendingMasterPrompts.mockReturnValueOnce(cancelled);
    const out = h.hitl.cancelPendingMasterPrompts();
    expect(out).toBe(cancelled);
    expect(h.bus.publish).toHaveBeenCalledWith('master_prompt_cancelled', { prompt: cancelled[0] });
    expect(h.bus.publish).toHaveBeenCalledWith('master_prompt_cancelled', { prompt: cancelled[1] });
  });

  it('is a no-op when nothing was pending', () => {
    h.store.cancelPendingMasterPrompts.mockReturnValueOnce([]);
    expect(h.hitl.cancelPendingMasterPrompts()).toEqual([]);
    expect(h.bus.publish).not.toHaveBeenCalled();
  });
});

describe('HumanInTheLoop — subordinate resolvers', () => {
  let h: Harness;
  beforeEach(() => { h = makeHarness(); });

  it('hasPending* return false when no agent is queued', () => {
    expect(h.hitl.hasPendingPlan(1)).toBe(false);
    expect(h.hitl.hasPendingQuestion(1)).toBe(false);
    expect(h.hitl.hasPendingTasks(1)).toBe(false);
  });

  it('resolvePlan returns false when no pending entry exists', () => {
    expect(h.hitl.resolvePlan(99, true)).toBe(false);
    expect(h.board.post).not.toHaveBeenCalled();
  });

  it('resolveQuestion returns false when no pending entry exists', () => {
    expect(h.hitl.resolveQuestion(99, 'x')).toBe(false);
    expect(h.bus.publish).not.toHaveBeenCalled();
  });

  it('resolveTasks returns false when no pending entry exists', () => {
    expect(h.hitl.resolveTasks(99, true)).toBe(false);
  });

  it('clearForAgent / clearAll do not throw on empty state', () => {
    expect(() => h.hitl.clearForAgent(1)).not.toThrow();
    expect(() => h.hitl.clearAll()).not.toThrow();
  });
});

describe('HumanInTheLoop — consumeMasterShouldContinue', () => {
  it('defaults to false', () => {
    const h = makeHarness();
    expect(h.hitl.consumeMasterShouldContinue()).toBe(false);
  });

  it('is set to true by both plan and question resolution', () => {
    const h = makeHarness();
    h.store.getPendingMasterPrompt.mockReturnValueOnce({ id: 1 });
    h.store.resolveMasterPrompt.mockReturnValueOnce(masterPrompt({ id: 1 }));
    h.hitl.respondToMasterPlan(true);
    expect(h.hitl.consumeMasterShouldContinue()).toBe(true);

    h.store.getPendingMasterPrompt.mockReturnValueOnce({ id: 2 });
    h.store.resolveMasterPrompt.mockReturnValueOnce(masterPrompt({ id: 2, kind: 'question' }));
    h.hitl.respondToMasterQuestion('hi');
    expect(h.hitl.consumeMasterShouldContinue()).toBe(true);
  });
});
