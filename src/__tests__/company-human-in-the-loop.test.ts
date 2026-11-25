import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HumanInTheLoop } from '@mcp/company/services/HumanInTheLoop.js';
import type { MasterPrompt } from '@mcp/company-contracts';

const SESSION_ID = '00000000-0000-4000-8000-000000000042';
const MASTER_RUN_ID = '00000000-0000-4000-8000-000000000100';
const OTHER_RUN_ID = '00000000-0000-4000-8000-000000000199';
const PROMPT_1_ID = '00000000-0000-4000-8000-000000000201';
const PROMPT_2_ID = '00000000-0000-4000-8000-000000000202';
const PROMPT_3_ID = '00000000-0000-4000-8000-000000000203';
const PROMPT_7_ID = '00000000-0000-4000-8000-000000000207';
const PROMPT_9_ID = '00000000-0000-4000-8000-000000000209';

function masterPrompt(overrides: Partial<MasterPrompt> = {}): MasterPrompt {
  return {
    id: PROMPT_1_ID,
    company_session_id: SESSION_ID,
    agent_run_id: MASTER_RUN_ID,
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
  status: { setStatus: ReturnType<typeof vi.fn>; publishStatus: ReturnType<typeof vi.fn> };
  store: {
    claimMasterPromptDelivery: ReturnType<typeof vi.fn>;
    completeMasterPromptDelivery: ReturnType<typeof vi.fn>;
    releaseMasterPromptDelivery: ReturnType<typeof vi.fn>;
    markMasterPromptDeliveryOutcomeUnknown: ReturnType<typeof vi.fn>;
    getPendingMasterPrompt: ReturnType<typeof vi.fn>;
    cancelPendingMasterPrompts: ReturnType<typeof vi.fn>;
    createMasterPrompt: ReturnType<typeof vi.fn>;
  };
  master: {
    handle: { runner: { provideUserInput: ReturnType<typeof vi.fn>; interruptWait: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> } } | null;
    agentRunId: string | null;
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
  const status = { setStatus: vi.fn(), publishStatus: vi.fn() };
  const store = {
    claimMasterPromptDelivery: vi.fn(async (id: string) => ({
      kind: 'claimed' as const,
      prompt: masterPrompt({ id }),
      token: 'claimed-token',
    })),
    completeMasterPromptDelivery: vi.fn(),
    releaseMasterPromptDelivery: vi.fn(async () => true),
    markMasterPromptDeliveryOutcomeUnknown: vi.fn(async () => true),
    getPendingMasterPrompt: vi.fn(async () => null),
    cancelPendingMasterPrompts: vi.fn(async () => []),
    createMasterPrompt: vi.fn(async () => masterPrompt()),
  };
  const master = {
    handle: handle as Harness['master']['handle'],
    agentRunId: MASTER_RUN_ID,
    isAlive: handle != null,
    endedWithError: null,
    notify: vi.fn(),
    setShouldContinue: vi.fn(),
  };
  const attention = { signal: vi.fn(), on: vi.fn(), emit: vi.fn() };

  const ctx = {
    companySessionId: SESSION_ID,
    companyFiles: store as never,
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

  it('returns null when the master handle is gone', async () => {
    const h2 = makeHarness({ masterAlive: false });
    await expect(h2.hitl.respondToMasterPlan(true)).resolves.toBeNull();
    expect(h2.store.claimMasterPromptDelivery).not.toHaveBeenCalled();
  });

  it('returns null when there is no pending prompt id available', async () => {
    h.store.getPendingMasterPrompt.mockReturnValueOnce(null);
    await expect(h.hitl.respondToMasterPlan(true)).resolves.toBeNull();
  });

  it('returns null when the prompt delivery claim reports already-resolved', async () => {
    h.store.getPendingMasterPrompt.mockReturnValueOnce({ id: PROMPT_7_ID });
    h.store.claimMasterPromptDelivery.mockReturnValueOnce({
      kind: 'not_pending',
      prompt: null,
    });
    await expect(h.hitl.respondToMasterPlan(true)).resolves.toBeNull();
  });

  it('resolves with explicit promptId, sends to runner, sets running status, posts decision', async () => {
    const resolved = masterPrompt({ id: PROMPT_7_ID, status: 'answered', approved: true });
    h.store.completeMasterPromptDelivery.mockReturnValueOnce(resolved);
    const result = await h.hitl.respondToMasterPlan(true, 'lgtm', PROMPT_7_ID);
    expect(result).toBe(resolved);
    expect(h.store.completeMasterPromptDelivery).toHaveBeenCalledWith(
      PROMPT_7_ID,
      expect.any(String),
      {
      kind: 'plan', approved: true, feedback: 'lgtm',
      },
    );
    expect(h.master.handle!.runner.provideUserInput).toHaveBeenCalledWith(
      JSON.stringify({ approved: true, feedback: 'lgtm' }),
    );
    expect(h.master.setShouldContinue).toHaveBeenCalledWith(true);
    expect(h.status.publishStatus).toHaveBeenCalledWith(MASTER_RUN_ID, 'master', 'running');
    expect(h.board.post).toHaveBeenCalledWith('human', null, 'decision', 'Plan APPROVED: lgtm');
    expect(h.bus.publish).toHaveBeenCalledWith('master_plan_resolved', { prompt: resolved });
  });

  it('falls back to getPendingMasterPrompt when no promptId is supplied', async () => {
    const resolved = masterPrompt({ id: PROMPT_9_ID });
    h.store.getPendingMasterPrompt.mockReturnValueOnce({ id: PROMPT_9_ID });
    h.store.completeMasterPromptDelivery.mockReturnValueOnce(resolved);
    await h.hitl.respondToMasterPlan(false);
    expect(h.store.getPendingMasterPrompt).toHaveBeenCalledWith('plan');
    expect(h.store.completeMasterPromptDelivery).toHaveBeenCalledWith(
      PROMPT_9_ID,
      expect.any(String),
      { kind: 'plan', approved: false, feedback: undefined },
    );
  });

  it('encodes REJECTED decisions for the board', async () => {
    h.store.getPendingMasterPrompt.mockReturnValueOnce({ id: PROMPT_1_ID });
    h.store.completeMasterPromptDelivery.mockReturnValueOnce(
      masterPrompt({ id: PROMPT_1_ID, approved: false }),
    );
    await h.hitl.respondToMasterPlan(false);
    expect(h.board.post).toHaveBeenCalledWith('human', null, 'decision', 'Plan REJECTED');
  });

  it('consumeMasterShouldContinue returns true exactly once after a plan resolution', async () => {
    h.store.getPendingMasterPrompt.mockReturnValueOnce({ id: PROMPT_1_ID });
    h.store.completeMasterPromptDelivery.mockReturnValueOnce(masterPrompt({ id: PROMPT_1_ID }));
    await h.hitl.respondToMasterPlan(true);
    expect(h.hitl.consumeMasterShouldContinue()).toBe(true);
    expect(h.hitl.consumeMasterShouldContinue()).toBe(false);
  });
});

describe('HumanInTheLoop — master question', () => {
  let h: Harness;
  beforeEach(() => { h = makeHarness(); });

  it('returns null when no handle', async () => {
    const h2 = makeHarness({ masterAlive: false });
    await expect(h2.hitl.respondToMasterQuestion('hi')).resolves.toBeNull();
  });

  it('resolves and publishes master_question_resolved', async () => {
    const resolved = masterPrompt({ id: PROMPT_3_ID, kind: 'question', answer: 'yes' });
    h.store.completeMasterPromptDelivery.mockReturnValueOnce(resolved);
    const out = await h.hitl.respondToMasterQuestion('yes', PROMPT_3_ID);
    expect(out).toBe(resolved);
    expect(h.store.completeMasterPromptDelivery).toHaveBeenCalledWith(
      PROMPT_3_ID,
      expect.any(String),
      { kind: 'question', answer: 'yes' },
    );
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

  it('publishes cancellation events for every prompt', async () => {
    const cancelled = [
      masterPrompt({ id: PROMPT_1_ID, status: 'cancelled' }),
      masterPrompt({ id: PROMPT_2_ID, status: 'cancelled', kind: 'question' }),
    ];
    h.store.cancelPendingMasterPrompts.mockReturnValueOnce(cancelled);
    const out = await h.hitl.cancelPendingMasterPrompts();
    expect(out).toBe(cancelled);
    expect(h.bus.publish).toHaveBeenCalledWith('master_prompt_cancelled', { prompt: cancelled[0] });
    expect(h.bus.publish).toHaveBeenCalledWith('master_prompt_cancelled', { prompt: cancelled[1] });
  });

  it('is a no-op when nothing was pending', async () => {
    h.store.cancelPendingMasterPrompts.mockReturnValueOnce([]);
    await expect(h.hitl.cancelPendingMasterPrompts()).resolves.toEqual([]);
    expect(h.bus.publish).not.toHaveBeenCalled();
  });
});

describe('HumanInTheLoop — subordinate resolvers', () => {
  let h: Harness;
  beforeEach(() => { h = makeHarness(); });

  it('hasPending* return false when no agent is queued', () => {
    expect(h.hitl.hasPendingPlan(MASTER_RUN_ID)).toBe(false);
    expect(h.hitl.hasPendingQuestion(MASTER_RUN_ID)).toBe(false);
    expect(h.hitl.hasPendingTasks(MASTER_RUN_ID)).toBe(false);
  });

  it('resolvePlan returns false when no pending entry exists', () => {
    expect(h.hitl.resolvePlan(OTHER_RUN_ID, true)).toBe(false);
    expect(h.board.post).not.toHaveBeenCalled();
  });

  it('resolveQuestion returns false when no pending entry exists', () => {
    expect(h.hitl.resolveQuestion(OTHER_RUN_ID, 'x')).toBe(false);
    expect(h.bus.publish).not.toHaveBeenCalled();
  });

  it('resolveTasks returns false when no pending entry exists', () => {
    expect(h.hitl.resolveTasks(OTHER_RUN_ID, true)).toBe(false);
  });

  it('clearForAgent / clearAll do not throw on empty state', () => {
    expect(() => h.hitl.clearForAgent(MASTER_RUN_ID)).not.toThrow();
    expect(() => h.hitl.clearAll()).not.toThrow();
  });
});

describe('HumanInTheLoop — consumeMasterShouldContinue', () => {
  it('defaults to false', () => {
    const h = makeHarness();
    expect(h.hitl.consumeMasterShouldContinue()).toBe(false);
  });

  it('is set to true by both plan and question resolution', async () => {
    const h = makeHarness();
    h.store.getPendingMasterPrompt.mockReturnValueOnce({ id: PROMPT_1_ID });
    h.store.completeMasterPromptDelivery.mockReturnValueOnce(masterPrompt({ id: PROMPT_1_ID }));
    await h.hitl.respondToMasterPlan(true);
    expect(h.hitl.consumeMasterShouldContinue()).toBe(true);

    h.store.getPendingMasterPrompt.mockReturnValueOnce({ id: PROMPT_2_ID });
    h.store.completeMasterPromptDelivery.mockReturnValueOnce(
      masterPrompt({ id: PROMPT_2_ID, kind: 'question' }),
    );
    await h.hitl.respondToMasterQuestion('hi');
    expect(h.hitl.consumeMasterShouldContinue()).toBe(true);
  });
});
